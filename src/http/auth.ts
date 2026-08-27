import { timingSafeEqual } from "node:crypto";
import { discordBotToken, loadEnv } from "../config.ts";
import type { Namespace } from "../context/types.ts";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    if (ba.length > 0) timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m?.[1] ?? null;
}

export type AuthOk = { ok: true; namespace: Namespace };
export type AuthErr = { ok: false; status: 401 | 403; error: string };
export type AuthResult = AuthOk | AuthErr;

/**
 * Derive namespace from which scoped API token matched.
 * A client-supplied namespace is not authorization: mismatch → 403.
 * DISCORD_BOT_TOKEN is never accepted as this bearer.
 */
export function authorizeV1(req: Request, clientNamespace?: string | null): AuthResult {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "unauthorized" };

  const env = loadEnv();
  try {
    const bot = discordBotToken(env);
    if (safeEqual(token, bot)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
  } catch {
    // bot token unset in some tests — ignore
  }

  let namespace: Namespace | null = null;
  if (env.MORPHEUS_API_TOKEN_GENERAL && safeEqual(token, env.MORPHEUS_API_TOKEN_GENERAL)) {
    namespace = "general";
  } else if (env.MORPHEUS_API_TOKEN_LEADERSHIP && safeEqual(token, env.MORPHEUS_API_TOKEN_LEADERSHIP)) {
    namespace = "leadership";
  }
  if (!namespace) return { ok: false, status: 401, error: "unauthorized" };

  if (clientNamespace != null && clientNamespace !== "" && clientNamespace !== namespace) {
    return { ok: false, status: 403, error: "namespace mismatch" };
  }
  return { ok: true, namespace };
}
