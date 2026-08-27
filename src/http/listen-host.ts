import { loadEnv } from "../config.ts";
import { isAllowedListenHost } from "./listen-allowlist.ts";

export { isAllowedListenHost } from "./listen-allowlist.ts";

/**
 * Bind address from HEALTH_HOST (zod allowlist: loopback or Tailscale).
 * Invalid values never reach here; fall back to loopback if they do.
 */
export function resolveListenHost(): string {
  const configured = loadEnv().HEALTH_HOST;
  if (!isAllowedListenHost(configured)) return "127.0.0.1";
  return configured;
}
