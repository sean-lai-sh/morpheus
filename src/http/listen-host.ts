import { loadEnv } from "../config.ts";

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";
}

/**
 * Bind address from HEALTH_HOST (zod, default 127.0.0.1).
 * Never a public wildcard NIC.
 */
export function resolveListenHost(): string {
  const configured = loadEnv().HEALTH_HOST;
  if (isWildcard(configured)) return "127.0.0.1";
  return configured;
}
