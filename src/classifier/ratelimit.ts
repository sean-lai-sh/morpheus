import Bottleneck from "bottleneck";

/**
 * NVIDIA NIM free tier is 40 RPM. We cap at 30 to leave headroom for retries
 * and small bursts. minTime=2000ms = 30 req/min.
 */
export const nimLimiter = new Bottleneck({
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60_000,
  maxConcurrent: 2,
  minTime: 2000,
});
