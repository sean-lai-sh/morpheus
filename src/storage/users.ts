import { getDb } from "./db.ts";

export interface UserRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  global_name: string | null;
  updated_at: number;
}

export function upsertUser(
  userId: string,
  username: string | null,
  displayName: string | null,
  globalName: string | null,
  at: number = Date.now(),
): void {
  getDb()
    .query(
      `INSERT INTO users (user_id, username, display_name, global_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         global_name = excluded.global_name,
         updated_at = excluded.updated_at`,
    )
    .run(userId, username, displayName, globalName, at);
}

export function getUser(userId: string): UserRow | null {
  return (
    getDb()
      .query<UserRow, [string]>(
        `SELECT user_id, username, display_name, global_name, updated_at FROM users WHERE user_id = ?`,
      )
      .get(userId) ?? null
  );
}

export function listUsers(): UserRow[] {
  return getDb()
    .query<UserRow, []>(`SELECT user_id, username, display_name, global_name, updated_at FROM users`)
    .all();
}

/** Returns the best known display name for a user: server nickname > global name > username. */
export function getDisplayName(userId: string): string | null {
  const row = getUser(userId);
  if (!row) return null;
  return row.display_name ?? row.global_name ?? row.username ?? null;
}

/** Match roster-style name hints against cached Discord profile fields. No emails. */
export function findUsersByNameHints(hints: string[]): UserRow[] {
  const cleaned = hints.map((hint) => hint.trim().toLowerCase()).filter((hint) => hint.length >= 2);
  if (cleaned.length === 0) return [];
  const found: UserRow[] = [];
  const seen = new Set<string>();
  for (const row of listUsers()) {
    const fields = [row.username, row.display_name, row.global_name]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());
    const hit = cleaned.some((hint) =>
      fields.some((field) => field === hint || field.startsWith(`${hint} `) || field.endsWith(` ${hint}`)),
    );
    if (!hit || seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    found.push(row);
  }
  return found;
}
