import { networkInterfaces } from "node:os";
import { loadEnv } from "../config.ts";

const TAILSCALE_CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";
}

function isTailscaleIpv4(ip: string): boolean {
  return TAILSCALE_CGNAT_RE.test(ip);
}

function tailscaleFromInterfaces(): string | null {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal && isTailscaleIpv4(a.address)) {
        return a.address;
      }
    }
  }
  return null;
}

function tailscaleFromCli(): string | null {
  try {
    const proc = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const ip = proc.stdout.toString().trim().split(/\s+/)[0];
    return ip && isTailscaleIpv4(ip) ? ip : null;
  } catch {
    return null;
  }
}

/**
 * Bind address for Morpheus HTTP.
 * Prefer HEALTH_HOST, then Tailscale IPv4, then 127.0.0.1.
 * Never a public wildcard NIC.
 */
export function resolveListenHost(): string {
  const configured = loadEnv().HEALTH_HOST?.trim();
  if (configured) {
    if (isWildcard(configured)) return "127.0.0.1";
    return configured;
  }
  return tailscaleFromCli() ?? tailscaleFromInterfaces() ?? "127.0.0.1";
}
