import { logger } from "../logger.ts";

/**
 * Minimal client for Nia's REST API (base: https://apigcp.trynia.ai/v2).
 *
 * Endpoints used:
 *   POST {base}/fs                          — create filesystem namespace
 *   PUT  {base}/fs/{id}/files               — push a file into the namespace
 *   GET  {base}/fs                          — list owned namespaces
 */

export interface CreatedFilesystem {
  id: string;
  name: string;
}

export class NiaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
  }
}

function baseUrl(): string {
  return (process.env.NIA_BASE_URL ?? "https://apigcp.trynia.ai/v2").replace(/\/$/, "");
}

function apiKey(): string {
  const key = process.env.NIA_API_KEY;
  if (!key) throw new Error("NIA_API_KEY not set in environment (Doppler)");
  return key;
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new NiaApiError(`Nia ${method} ${path} → ${res.status}`, res.status, text);
  }
  return res;
}

/** Create a bare filesystem namespace. Returns the source id. */
export async function createFilesystem(
  name: string,
  description?: string,
): Promise<CreatedFilesystem> {
  const res = await request("POST", "/fs", { name, description });
  const data = (await res.json()) as { id?: string; source_id?: string; name?: string };
  const id = data.id ?? data.source_id;
  if (!id) {
    throw new Error(
      `Nia did not return a filesystem id; response: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  return { id, name: data.name ?? name };
}

/**
 * Push a single file into a filesystem namespace.
 * Nia overwrites existing content at the same path — safe to call repeatedly.
 */
export async function pushFile(
  sourceId: string,
  filePath: string,
  content: string,
): Promise<void> {
  await request("PUT", `/fs/${encodeURIComponent(sourceId)}/files`, {
    path: filePath,
    body: content,
    encoding: "utf8",
  });
  logger.debug({ source_id: sourceId, path: filePath }, "nia file pushed");
}

/**
 * Delete a single file from a filesystem namespace.
 * Used to prune paths that no longer exist locally (e.g. after channel rename or layout migration).
 * For a full migration (flat → hierarchical), prefer re-registering with a fresh source ID instead.
 */
export async function deleteFile(sourceId: string, filePath: string): Promise<void> {
  await request("DELETE", `/fs/${encodeURIComponent(sourceId)}/files`, { path: filePath });
  logger.debug({ source_id: sourceId, path: filePath }, "nia file deleted");
}
