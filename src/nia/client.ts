import { logger } from "../logger.ts";

/**
 * Minimal client for Nia's REST API. Endpoints used:
 *   POST {NIA_BASE_URL}/v1/sources              — create a local_folder source
 *   POST {NIA_BASE_URL}/v1/sources/{id}/sync    — trigger re-index
 *
 * Auth: Bearer NIA_API_KEY.
 *
 * Note: Nia's exact wire format may evolve; if a request fails with 4xx, log
 * the response body for diagnosis rather than swallowing it. The syncer treats
 * 5xx and network errors as transient (debounce retry); 4xx surfaces to the
 * operator.
 */

export interface CreateLocalFolderRequest {
  name: string;
  path: string;
}

export interface CreatedSource {
  id: string;
  name: string;
  path: string;
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
  return process.env.NIA_BASE_URL ?? "https://api.trynia.ai";
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

export async function createLocalFolderSource(
  req: CreateLocalFolderRequest,
): Promise<CreatedSource> {
  // Per Nia docs: POST /v1/sources with { resource_type: "local_folder", path, name }
  const res = await request("POST", "/v1/sources", {
    resource_type: "local_folder",
    name: req.name,
    path: req.path,
  });
  const data = (await res.json()) as { id?: string; uuid?: string; name?: string; path?: string };
  const id = data.id ?? data.uuid;
  if (!id) {
    throw new Error(`Nia did not return a source id; response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id, name: data.name ?? req.name, path: data.path ?? req.path };
}

export async function syncSource(sourceId: string): Promise<void> {
  await request("POST", `/v1/sources/${encodeURIComponent(sourceId)}/sync`);
  logger.debug({ source_id: sourceId }, "nia sync triggered");
}
