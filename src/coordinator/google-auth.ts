import { z } from "zod";
import { emptyToUndef } from "../config.ts";

/**
 * Google service-account access tokens via **domain-wide delegation**.
 *
 * No SDK on purpose: `googleapis` / `google-auth-library` would drag a large
 * dependency tree onto the Mini for what is one signed JWT and one POST. Bun
 * ships Web Crypto, so we sign the assertion with `crypto.subtle` (RS256 =
 * RSASSA-PKCS1-v1_5 over SHA-256) and exchange it with `fetch`.
 *
 * Secret hygiene is the whole point of this file: the PKCS#8 private key, the
 * signed assertion, and the returned access token are never logged, never
 * thrown, and never embedded in an error message. A leaked service-account key
 * is a full Workspace compromise, so failures carry an HTTP status and a short
 * allowlisted OAuth error code only.
 */

export interface GoogleAuthConfig {
  clientEmail: string;
  /** PKCS#8 PEM private key from the service-account JSON. */
  privateKey: string;
  /** The user to impersonate via domain-wide delegation, e.g. hello@techatnyu.org. */
  subject: string;
  scopes: string[];
}

export interface GoogleTokenSource {
  getAccessToken(): Promise<string>;
}

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DEFAULT_IMPERSONATE_SUBJECT = "hello@techatnyu.org";
export const GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"] as const;

/** Google rejects an assertion whose `exp` is more than an hour past `iat`. */
const ASSERTION_TTL_SECONDS = 3600;
/** Refresh this long before the real deadline so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const envSchema = z.object({
  GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /** PKCS#8 PEM. Doppler stores it with literal `\n` sequences; see `pkcs8DerFromPem`. */
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /** Whose calendar the delegated token acts on. Defaults to hello@techatnyu.org. */
  GOOGLE_IMPERSONATE_SUBJECT: z.preprocess(emptyToUndef, z.string().min(1).optional()),
});

/**
 * Returns null when Google credentials are not configured. Absent credentials
 * are a normal state — the caller falls back to handing the calendar job to
 * Grok — so this never throws and never reports which var was missing (the
 * value could be pasted into a log line by a well-meaning caller).
 */
export function parseGoogleAuthEnv(raw: NodeJS.ProcessEnv = process.env): GoogleAuthConfig | null {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const clientEmail = e.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL?.trim();
  const privateKey = e.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!clientEmail || !privateKey?.trim()) return null;
  return {
    clientEmail,
    privateKey,
    subject: e.GOOGLE_IMPERSONATE_SUBJECT?.trim() || DEFAULT_IMPERSONATE_SUBJECT,
    scopes: [...GOOGLE_CALENDAR_SCOPES],
  };
}

// ---------------------------------------------------------------------------
// PEM / base64url
// ---------------------------------------------------------------------------

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * PEM armor → DER bytes for `crypto.subtle.importKey("pkcs8", ...)`.
 *
 * The key reaches us straight out of the service-account JSON, so the newlines
 * may still be the two-character escape `\n` rather than real line breaks
 * (Doppler round-trips the JSON-escaped form). Both shapes are accepted.
 * Nothing derived from the key ever reaches the thrown messages here.
 */
function pkcs8DerFromPem(pem: string): Uint8Array {
  const normalized = pem.replace(/\\[rn]/g, "\n");
  const body = PEM_BLOCK.exec(normalized)?.[1];
  if (!body) {
    throw new Error("Google service-account private key is not a PKCS#8 PEM block");
  }
  const base64 = body.replace(/\s+/g, "");
  if (!BASE64.test(base64)) {
    throw new Error("Google service-account private key PEM body is not valid base64");
  }
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
  return der;
}

const encoder = new TextEncoder();

/** base64url: no padding, `-`/`_` instead of `+`/`/` (RFC 7515 §2). */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pkcs8DerFromPem(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // The underlying error is dropped deliberately: it can quote key material.
    throw new Error("Google service-account private key could not be imported (expected RSA PKCS#8)");
  }
}

// ---------------------------------------------------------------------------
// Assertion
// ---------------------------------------------------------------------------

async function buildAssertion(
  config: GoogleAuthConfig,
  key: CryptoKey,
  issuedAtSec: number,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: config.clientEmail,
    /**
     * `sub` is what makes this **domain-wide delegation**: Google mints the
     * token as this Workspace user. Drop it and you get a token for the bare
     * service account, which owns no calendar and cannot see hello@'s events —
     * every Calendar call then 404s in a way that looks like a missing event.
     */
    sub: config.subject,
    scope: config.scopes.join(" "),
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: issuedAtSec,
    exp: issuedAtSec + ASSERTION_TTL_SECONDS,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

/** OAuth error codes are short snake_case tokens (`invalid_grant`, `unauthorized_client`). */
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * A failure message an operator can act on that still cannot carry a secret:
 * status plus, when it matches the allowlist, Google's `error` code. The
 * `error_description` is deliberately discarded — it is free-form text from the
 * remote side and the assertion we just sent is the one thing it must never
 * echo back into our logs.
 */
async function describeFailure(res: Response): Promise<string> {
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && SAFE_ERROR_CODE.test(body.error)) code = body.error;
  } catch {
    // Non-JSON body: ignore it entirely rather than risk echoing the assertion.
  }
  const suffix = code ? `, error=${code}` : "";
  return `Google token request failed (HTTP ${res.status}${suffix})`;
}

export function createGoogleTokenSource(
  config: GoogleAuthConfig,
  opts?: { fetchImpl?: typeof fetch; now?: () => number },
): GoogleTokenSource {
  const doFetch = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? Date.now;

  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;
  let keyPromise: Promise<CryptoKey> | null = null;

  function privateKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = importPrivateKey(config.privateKey).catch((err: unknown) => {
        keyPromise = null;
        throw err;
      });
    }
    return keyPromise;
  }

  async function refresh(): Promise<string> {
    const startedAtMs = now();
    const key = await privateKey();
    const assertion = await buildAssertion(config, key, Math.floor(startedAtMs / 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const res = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(await describeFailure(res));

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error("Google token response was not JSON");
    }
    const parsed = tokenResponseSchema.safeParse(payload);
    // Static message: zod issue text would be echoing the response back out.
    if (!parsed.success) throw new Error("Google token response was missing access_token/expires_in");

    // Deadline comes from `expires_in`, not a hardcoded hour — Google is free
    // to hand back a shorter-lived token than the assertion asked for.
    cached = { token: parsed.data.access_token, expiresAtMs: startedAtMs + parsed.data.expires_in * 1000 };
    return parsed.data.access_token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached && now() + EXPIRY_SKEW_MS < cached.expiresAtMs) return cached.token;
      // Collapse concurrent refreshes onto one token request; the stored
      // promise is cleared either way so a failure never poisons the source.
      if (inFlight) return inFlight;
      const pending = refresh();
      inFlight = pending;
      pending
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        })
        .catch(() => {
          // Swallowed on the derived promise only; callers still see `pending` reject.
        });
      return pending;
    },
  };
}
