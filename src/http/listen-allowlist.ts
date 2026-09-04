/**
 * Bind allowlist for Morpheus HTTP.
 * Loopback or Tailscale only — never LAN/WAN unicasts or all-interfaces.
 */

const TAILSCALE_CGNAT_V4 =
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){2}$/;
/** Tailscale's actual ULA prefix fd7a:115c:a1e0::/48 — not every fd7a: address. */
const TAILSCALE_ULA_V6 = /^fd7a:115c:a1e0:/i;

function bareHost(host: string): string {
  const h = host.trim();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

export function isAllowedListenHost(host: string): boolean {
  const h = bareHost(host).trim();
  if (h === "127.0.0.1" || h === "::1") return true;
  if (TAILSCALE_CGNAT_V4.test(h)) return true;
  if (TAILSCALE_ULA_V6.test(h)) return true;
  return false;
}
