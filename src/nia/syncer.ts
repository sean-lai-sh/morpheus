import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.ts";
import { getSyncState, markSyncFailure, markSyncSuccess } from "../storage/sync-state.ts";
import { GENERAL_DIR, LEADERSHIP_DIR } from "../storage/markdown.ts";
import { NiaApiError, pushFile } from "./client.ts";

const POLL_INTERVAL_MS = 60_000;
const ALERT_AFTER_FAILURES = 10;

/** Recursively collect all .md file paths under a directory. */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir) as string[];
  } catch {
    return results;
  }
  for (const name of names) {
    const full = resolve(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectMarkdownFiles(full));
      } else if (stat.isFile() && name.endsWith(".md")) {
        results.push(full);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return results;
}

/** Push every .md file under rootDir to the given Nia filesystem namespace. */
async function pushAll(sourceId: string, rootDir: string): Promise<void> {
  const files = collectMarkdownFiles(rootDir);
  if (files.length === 0) {
    logger.warn({ dir: rootDir }, "nia sync: directory empty or not readable; skipping");
    return;
  }
  for (const filePath of files) {
    // Use a relative path within the Nia namespace (strip the rootDir prefix).
    const relativePath = filePath.slice(rootDir.length + 1);
    const content = readFileSync(filePath, "utf8");
    await pushFile(sourceId, relativePath, content);
  }
  logger.info({ source_id: sourceId, files: files.length }, "nia: pushed all markdown files");
}

interface IndexConfig {
  rootDir: string;
  sourceIdEnvVar: string;
  label: string;
}

const INDEXES: IndexConfig[] = [
  { rootDir: GENERAL_DIR, sourceIdEnvVar: "NIA_DISCORD_SOURCE_ID", label: "general" },
  { rootDir: LEADERSHIP_DIR, sourceIdEnvVar: "NIA_DISCORD_LEADERSHIP_SOURCE_ID", label: "leadership" },
];

let pollerHandles: ReturnType<typeof setInterval>[] = [];
let inFlight: Record<string, boolean> = {};

async function flushIfDirty(idx: IndexConfig): Promise<void> {
  if (inFlight[idx.rootDir]) return;
  const state = getSyncState(idx.rootDir);
  if (!state.dirty) return;
  inFlight[idx.rootDir] = true;
  try {
    const sourceId = process.env[idx.sourceIdEnvVar];
    if (!sourceId) {
      logger.warn(
        { label: idx.label, env: idx.sourceIdEnvVar },
        "Nia source ID not set; skipping sync. Run `bun run register-nia` first.",
      );
      return;
    }
    await pushAll(sourceId, idx.rootDir);
    markSyncSuccess(idx.rootDir);
    logger.info({ source_id: sourceId, label: idx.label }, "nia sync succeeded");
  } catch (err) {
    const failures = markSyncFailure(idx.rootDir);
    if (err instanceof NiaApiError && err.status >= 400 && err.status < 500) {
      logger.error(
        { status: err.status, body: err.body.slice(0, 300), label: idx.label },
        "nia sync 4xx (auth/config issue, not transient)",
      );
    } else {
      logger.warn({ err, failures, label: idx.label }, "nia sync failed; will retry next poll");
    }
    if (failures >= ALERT_AFTER_FAILURES) {
      logger.error({ failures, label: idx.label }, "nia sync repeatedly failing — investigate");
    }
  } finally {
    inFlight[idx.rootDir] = false;
  }
}

/**
 * Start 60s pollers for both Nia indexes (general + leadership).
 */
export function startSyncer(): void {
  if (pollerHandles.length > 0) return;
  for (const idx of INDEXES) {
    const handle = setInterval(() => void flushIfDirty(idx), POLL_INTERVAL_MS);
    handle.unref();
    pollerHandles.push(handle);
  }
  logger.info({ interval_ms: POLL_INTERVAL_MS, indexes: INDEXES.length }, "nia syncer started");
}

export function stopSyncer(): void {
  for (const h of pollerHandles) clearInterval(h);
  pollerHandles = [];
}

/** Force a flush of both indexes right now. Used at end of backfill or on graceful shutdown. */
export async function flushNow(): Promise<void> {
  await Promise.all(INDEXES.map((idx) => flushIfDirty(idx)));
}
