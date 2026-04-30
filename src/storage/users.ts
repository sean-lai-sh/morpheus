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

/** Returns the best known display name for a user: server nickname > global name > username. */
export function getDisplayName(userId: string): string | null {
  const row = getDb()
    .query<Pick<UserRow, "display_name" | "global_name" | "username">, [string]>(
      `SELECT display_name, global_name, username FROM users WHERE user_id = ?`,
    )
    .get(userId);
  if (!row) return null;
  return row.display_name ?? row.global_name ?? row.username ?? null;
}
