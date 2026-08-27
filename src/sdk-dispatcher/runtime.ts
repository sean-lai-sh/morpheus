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
 * The agent never gets shell/edit/write: it may only call our custom tools
 * (the `mcp` family carries `local.customTools`) and search the web — enough
 * to answer Discord questions, nothing that can touch the Mini's disk.
 * Not persisted on the agent, so pass again on every create/resume.
 */
const AGENT_TOOLS: ToolName[] = ["mcp", "webSearch"];

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
      const { Agent } = await import("@cursor/sdk");
      return wrapAgent(await Agent.resume(agentId, agentOptions(opts)));
    },
  };
}
