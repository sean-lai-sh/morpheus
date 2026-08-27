import { timingSafeEqual } from "node:crypto";
import { discordBotToken, loadEnv, loadWorkspaceTokens } from "../config.ts";
import { scopeFor } from "../context/namespace.ts";
import type { Scope } from "../context/types.ts";

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

export type AuthOk = { ok: true; scope: Scope };
export type AuthErr = { ok: false; status: 401 | 403; error: string };
export type AuthResult = AuthOk | AuthErr;

/**
 * Derive the access scope from which workspace token matched
 * (`workspaces.<id>.token_env` in channels.yml). The scope is that workspace
 * plus all descendants. A client-supplied namespace is not authorization:
 * mismatch with the token's root → 403. DISCORD_BOT_TOKEN is never accepted.
 */
export function authorizeV1(req: Request, clientNamespace?: string | null): AuthResult {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "unauthorized" };

  try {
    const bot = discordBotToken(loadEnv());
    if (safeEqual(token, bot)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
  } catch {
    // bot token unset in some tests — ignore
  }

  // Compare against every configured token (no early return) so timing is uniform.
  let matched: string | null = null;
  for (const t of loadWorkspaceTokens()) {
    if (safeEqual(token, t.token)) matched = t.workspace;
  }
  if (!matched) return { ok: false, status: 401, error: "unauthorized" };

  const scope = scopeFor(matched);
  if (!scope) return { ok: false, status: 401, error: "unauthorized" };

  if (clientNamespace != null && clientNamespace !== "" && clientNamespace !== scope.root) {
    return { ok: false, status: 403, error: "namespace mismatch" };
  }
  return { ok: true, scope };
}
