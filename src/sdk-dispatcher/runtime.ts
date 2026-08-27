import type { AgentOptions, SDKAgent, SDKCustomTool, ToolName } from "@cursor/sdk";

/**
 * Narrow seam over `@cursor/sdk` so the dispatcher is testable without the
 * real SDK: tests inject a fake `SdkRuntime`; production uses
 * `createCursorSdkRuntime()` which dynamically imports the package. CI never
 * calls live Cursor.
 */

export interface SdkRunResult {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { message: string; code?: string };
}

export interface SdkRunHandle {
  wait(): Promise<SdkRunResult>;
}

export interface SdkSendOptions {
  /** Per-run custom tools (Tailscale Morpheus fs + job complete). */
  customTools?: Record<string, SDKCustomTool>;
}

export interface SdkAgentHandle {
  readonly agentId: string;
  send(prompt: string, options?: SdkSendOptions): Promise<SdkRunHandle>;
}

export interface SdkRuntime {
  /** `createAgentPlatform().prewarmLocalWorkspace()` — first ping is not a workspace scan. */
  prewarm(): Promise<() => Promise<void>>;
  createAgent(): Promise<SdkAgentHandle>;
  resumeAgent(agentId: string): Promise<SdkAgentHandle>;
}

export interface CursorSdkRuntimeOptions {
  /** Never logged; only handed to the SDK. */
  apiKey: string;
  model: string;
  cwd: string;
}

/**
 * The agent gets ONLY our custom tools (the `mcp` family carries
 * `local.customTools`): no shell/edit/write, and no webSearch — untrusted
 * Discord text must have no outbound channel beyond the scoped Morpheus API.
 * Not persisted on the agent, so pass again on every create/resume.
 */
const AGENT_TOOLS: ToolName[] = ["mcp"];

/**
 * Local SDK agent ids are `agent-…`; the SDK auto-detects `bc-…` on
 * `Agent.resume` as CLOUD and would attach a cloud runtime. Cloud is vetoed
 * for this path, so anything that is not a local id is refused before the SDK
 * is even imported.
 */
export function isLocalAgentId(agentId: string): boolean {
  return /^agent-\S+$/.test(agentId);
}

export function assertLocalAgentId(agentId: string): void {
  if (!isLocalAgentId(agentId)) {
    throw new Error(
      `refusing Agent.resume("${agentId.slice(0, 12)}…"): only local "agent-…" ids may be resumed (cloud runtime is vetoed)`,
    );
  }
}

function agentOptions(opts: CursorSdkRuntimeOptions): AgentOptions {
  return {
    apiKey: opts.apiKey,
    model: { id: opts.model },
    tools: [...AGENT_TOOLS],
    local: { cwd: opts.cwd },
  };
}

function wrapAgent(agent: SDKAgent): SdkAgentHandle {
  return {
    agentId: agent.agentId,
    async send(prompt, options) {
      const run = await agent.send(
        prompt,
        options?.customTools ? { local: { customTools: options.customTools } } : undefined,
      );
      return {
        async wait() {
          const result = await run.wait();
          return {
            status: result.status,
            ...(result.result != null ? { result: result.result } : {}),
            ...(result.error != null ? { error: result.error } : {}),
          };
        },
      };
    },
  };
}

/** Local runtime only. Cloud (`bc-…`) is vetoed for the chat path — repo-only. */
export function createCursorSdkRuntime(opts: CursorSdkRuntimeOptions): SdkRuntime {
  return {
    async prewarm() {
      const { createAgentPlatform } = await import("@cursor/sdk");
      const platform = await createAgentPlatform();
      return platform.prewarmLocalWorkspace(agentOptions(opts));
    },
    async createAgent() {
      const { Agent } = await import("@cursor/sdk");
      return wrapAgent(await Agent.create(agentOptions(opts)));
    },
    async resumeAgent(agentId) {
      assertLocalAgentId(agentId);
      const { Agent } = await import("@cursor/sdk");
      return wrapAgent(await Agent.resume(agentId, agentOptions(opts)));
    },
  };
}
