import type { AnyThreadChannel, TextChannel } from "discord.js";

/**
 * discord.js `fetchArchived` `before` for public threads and private+fetchAll
 * is an archive Date, not a thread snowflake.
 *
 * Passing a 17–19 digit id looks up `archivedAt` on the ThreadManager cache
 * (`ThreadManager.fetchArchived` in discord.js 14.16). Cache miss → the query
 * param is omitted → the same first page returns forever while `hasMore` is
 * true. Channels with >100 archived threads never finish listing (#70/#72).
 */
export function archivedBeforeCursor(threads: Iterable<AnyThreadChannel>): number | undefined {
  let min: number | undefined;
  for (const t of threads) {
    const ts = t.archiveTimestamp ?? t.archivedAt?.getTime();
    if (ts == null) continue;
    if (min == null || ts < min) min = ts;
  }
  return min;
}

/** Paginate public or private archived threads (discord.js defaults type to public). */
export async function forEachArchivedThread(
  ch: TextChannel,
  type: "public" | "private",
  fetchAll: boolean,
  fn: (thread: AnyThreadChannel) => Promise<void>,
): Promise<void> {
  let hasMore = true;
  let before: number | undefined;
  const seen = new Set<string>();
  while (hasMore) {
    const archived = await ch.threads.fetchArchived({
      type,
      fetchAll,
      limit: 100,
      ...(before != null ? { before } : {}),
    });
    if (archived.threads.size === 0) break;
    for (const t of archived.threads.values()) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      await fn(t);
    }
    const nextBefore = archivedBeforeCursor(archived.threads.values());
    hasMore = Boolean(archived.hasMore);
    if (!hasMore) break;
    // No timestamp on the page, or the cursor did not move: stop rather than
    // refetching the same first page (discord.js drops unresolved snowflakes).
    if (nextBefore == null || (before != null && nextBefore >= before)) break;
    before = nextBefore;
  }
}

/** Active + paginated public and private archived threads — same listing as backfill. */
export async function listChannelThreads(ch: TextChannel): Promise<AnyThreadChannel[]> {
  const out: AnyThreadChannel[] = [];
  const seen = new Set<string>();
  const add = async (t: AnyThreadChannel) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
  };

  const active = await ch.threads.fetchActive();
  for (const t of active.threads.values()) await add(t);

  await forEachArchivedThread(ch, "public", false, add);
  // All private archived (needs Manage Threads). A throw skips this channel's
  // thread diffs rather than pretending the list was complete (#72).
  await forEachArchivedThread(ch, "private", true, add);
  return out;
}
