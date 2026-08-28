import { describe, expect, test } from "bun:test";
import {
  createGoogleTokenSource,
  DEFAULT_IMPERSONATE_SUBJECT,
  GOOGLE_TOKEN_ENDPOINT,
  parseGoogleAuthEnv,
  type GoogleAuthConfig,
} from "../src/coordinator/google-auth.ts";

/**
 * Throwaway RSA keypair so the suite exercises real RS256 signing without any
 * real credential ever existing on disk or in Doppler.
 */
const keypair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

const PRIVATE_KEY_PEM = pemFromPkcs8(await crypto.subtle.exportKey("pkcs8", keypair.privateKey));
/** The base64 body only — what must never appear in a thrown message. */
const PRIVATE_KEY_BODY = PRIVATE_KEY_PEM.split("\n").slice(1, -2).join("");

function pemFromPkcs8(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function config(overrides: Partial<GoogleAuthConfig> = {}): GoogleAuthConfig {
  return {
    clientEmail: "morpheus-calendar@techatnyu.iam.gserviceaccount.com",
    privateKey: PRIVATE_KEY_PEM,
    subject: "hello@techatnyu.org",
    scopes: ["https://www.googleapis.com/auth/calendar"],
    ...overrides,
  };
}

/** base64url -> raw bytes. The signature is binary, so it must never go through TextDecoder. */
function decodeSegmentBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeSegment(segment: string): string {
  return new TextDecoder().decode(decodeSegmentBytes(segment));
}

/** Verifies the JWT signature against the throwaway public key. */
async function verifyAssertion(assertion: string): Promise<boolean> {
  const [h, c, s] = assertion.split(".");
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    keypair.publicKey,
    decodeSegmentBytes(s!),
    new TextEncoder().encode(`${h}.${c}`),
  );
}

interface Recorded {
  url: string;
  body: URLSearchParams;
  headers: Record<string, string>;
}

/** Fake fetch that records every request and replies from `respond`. */
function recorder(respond: (n: number) => Promise<Response> | Response) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")), headers });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("google-auth assertion", () => {
  test("signs a delegated JWT: sub is the impersonated user, iss the service account", async () => {
    const { calls, fetchImpl } = recorder(() => tokenResponse("ya29.fake"));
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_700_000_000_000 });

    expect(await source.getAccessToken()).toBe("ya29.fake");
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const assertion = call.body.get("assertion")!;
    const [h, c, s] = assertion.split(".");
    expect(s).toBeTruthy();
    // base64url, never base64: no padding and no +/ characters anywhere.
    expect(assertion).not.toContain("=");
    expect(assertion).not.toContain("+");
    expect(assertion).not.toContain("/");

    expect(JSON.parse(decodeSegment(h!))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(decodeSegment(c!)) as Record<string, unknown>;
    expect(claims.iss).toBe("morpheus-calendar@techatnyu.iam.gserviceaccount.com");
    // Domain-wide delegation: without `sub` the token has no access to hello@'s calendar.
    expect(claims.sub).toBe("hello@techatnyu.org");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/calendar");

    // The signature is real RS256 over `${header}.${claims}`.
    expect(await verifyAssertion(assertion)).toBe(true);
  });

  test("exp is iat + 3600 and aud is the token endpoint", async () => {
    const { calls, fetchImpl } = recorder(() => tokenResponse("ya29.fake"));
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_700_000_123_456 });
    await source.getAccessToken();

    const claims = JSON.parse(decodeSegment(calls[0]!.body.get("assertion")!.split(".")[1]!)) as {
      iat: number;
      exp: number;
      aud: string;
    };
    expect(claims.iat).toBe(1_700_000_123);
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.aud).toBe(GOOGLE_TOKEN_ENDPOINT);
  });
});

describe("google-auth caching", () => {
  test("reuses the cached token inside the validity window", async () => {
    const { calls, fetchImpl } = recorder((n) => tokenResponse(`token-${n}`));
    let clock = 1_000_000;
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => clock });

    expect(await source.getAccessToken()).toBe("token-1");
    clock += 3_000_000; // 3000s in: still well inside a 3600s token.
    expect(await source.getAccessToken()).toBe("token-1");
    expect(calls.length).toBe(1);
  });

  test("refreshes once the skew window is reached, using expires_in not a fixed hour", async () => {
    const { calls, fetchImpl } = recorder((n) => tokenResponse(`token-${n}`, 120));
    let clock = 1_000_000;
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => clock });

    expect(await source.getAccessToken()).toBe("token-1");
    clock += 59_000; // 61s of a 120s token left: still outside the 60s skew.
    expect(await source.getAccessToken()).toBe("token-1");
    expect(calls.length).toBe(1);

    clock += 2_000; // 59s left: inside the skew, so refresh.
    expect(await source.getAccessToken()).toBe("token-2");
    expect(calls.length).toBe(2);
  });

  test("concurrent callers share one in-flight token request", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = recorder(async (n) => {
      await gate;
      return tokenResponse(`token-${n}`);
    });
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_000_000 });

    const both = Promise.all([source.getAccessToken(), source.getAccessToken(), source.getAccessToken()]);
    release!();
    expect(await both).toEqual(["token-1", "token-1", "token-1"]);
    expect(calls.length).toBe(1);
  });

  test("a failed refresh does not poison the source", async () => {
    const { calls, fetchImpl } = recorder((n) =>
      n === 1 ? Promise.reject(new Error("network down")) : tokenResponse("token-2"),
    );
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_000_000 });

    await expect(source.getAccessToken()).rejects.toThrow("network down");
    expect(await source.getAccessToken()).toBe("token-2");
    expect(calls.length).toBe(2);
  });
});

describe("google-auth failure messages", () => {
  test("a non-200 throws with status and error code but no key or assertion", async () => {
    const { calls, fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            // Google echoing the assertion back would be the worst case: prove we drop it.
            error_description: "Invalid JWT Signature.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_000_000 });

    let message = "";
    try {
      await source.getAccessToken();
      throw new Error("expected getAccessToken to reject");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("400");
    expect(message).toContain("invalid_grant");

    const assertion = calls[0]!.body.get("assertion")!;
    expect(message).not.toContain(assertion);
    expect(message).not.toContain(assertion.split(".")[2]!); // not even the signature alone
    expect(message).not.toContain(PRIVATE_KEY_BODY);
    expect(message).not.toContain(PRIVATE_KEY_BODY.slice(0, 32));
    expect(message).not.toContain("PRIVATE KEY");
  });

  test("a hostile error_description is never echoed", async () => {
    let captured = "";
    const { fetchImpl } = recorder(async (_n) =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: captured }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    // Two-phase: first call captures the assertion, second replays it in the body.
    const capture = recorder(async (_n) => new Response("{}", { status: 500 }));
    const probe = createGoogleTokenSource(config(), { fetchImpl: capture.fetchImpl, now: () => 1_000_000 });
    await probe.getAccessToken().catch(() => {});
    captured = `assertion was ${capture.calls[0]!.body.get("assertion")}`;

    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_000_000 });
    const message = await source.getAccessToken().then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).not.toContain(capture.calls[0]!.body.get("assertion")!);
    expect(message).toBe("Google token request failed (HTTP 400, error=invalid_grant)");
  });

  test("a response without access_token throws a static message", async () => {
    const { fetchImpl } = recorder(
      () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    );
    const source = createGoogleTokenSource(config(), { fetchImpl, now: () => 1_000_000 });
    await expect(source.getAccessToken()).rejects.toThrow("missing access_token/expires_in");
  });

  test("a malformed PEM fails without quoting the key", async () => {
    const { fetchImpl } = recorder(() => tokenResponse("never"));
    const source = createGoogleTokenSource(config({ privateKey: "not-a-pem" }), { fetchImpl });
    const message = await source.getAccessToken().then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).toContain("PKCS#8 PEM block");
    expect(message).not.toContain("not-a-pem");
  });
});

describe("parseGoogleAuthEnv", () => {
  const escaped = PRIVATE_KEY_PEM.replace(/\n/g, "\\n");

  test("returns null when credentials are absent or blank", () => {
    expect(parseGoogleAuthEnv({})).toBeNull();
    expect(parseGoogleAuthEnv({ GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com" })).toBeNull();
    expect(parseGoogleAuthEnv({ GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: escaped })).toBeNull();
    expect(
      parseGoogleAuthEnv({
        GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "   ",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: escaped,
      }),
    ).toBeNull();
    expect(
      parseGoogleAuthEnv({
        GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "  ",
      }),
    ).toBeNull();
  });

  test("defaults the subject to hello@techatnyu.org and hardcodes the calendar scope", () => {
    const cfg = parseGoogleAuthEnv({
      GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: escaped,
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.subject).toBe(DEFAULT_IMPERSONATE_SUBJECT);
    expect(cfg!.subject).toBe("hello@techatnyu.org");
    expect(cfg!.scopes).toEqual(["https://www.googleapis.com/auth/calendar"]);
    expect(cfg!.clientEmail).toBe("svc@x.iam.gserviceaccount.com");
  });

  test("an explicit subject overrides the default", () => {
    const cfg = parseGoogleAuthEnv({
      GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: escaped,
      GOOGLE_IMPERSONATE_SUBJECT: " eboard@techatnyu.org ",
    });
    expect(cfg!.subject).toBe("eboard@techatnyu.org");
  });

  test("a Doppler-style key with literal \\n sequences still signs", async () => {
    const cfg = parseGoogleAuthEnv({
      GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: escaped,
    })!;
    expect(cfg.privateKey).toContain("\\n");
    expect(cfg.privateKey).not.toContain("\n");

    const { calls, fetchImpl } = recorder(() => tokenResponse("ya29.escaped"));
    const source = createGoogleTokenSource(cfg, { fetchImpl, now: () => 1_000_000 });
    expect(await source.getAccessToken()).toBe("ya29.escaped");

    expect(await verifyAssertion(calls[0]!.body.get("assertion")!)).toBe(true);
  });

  test("already-real newlines parse the same way", async () => {
    const cfg = parseGoogleAuthEnv({
      GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: PRIVATE_KEY_PEM,
    })!;
    const { fetchImpl } = recorder(() => tokenResponse("ya29.real"));
    const source = createGoogleTokenSource(cfg, { fetchImpl, now: () => 1_000_000 });
    expect(await source.getAccessToken()).toBe("ya29.real");
  });
});
