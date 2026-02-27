/** Claude Agent SDK session backend for stoops agents. */

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { RoomResolver, LLMSessionOptions, ILLMSession } from "../agent/types.js";
import type { ContentPart } from "../agent/types.js";
import { contentPartsToString } from "../agent/prompts.js";
import { createStoopsMcpServer, type StoopsMcpServer } from "../agent/mcp-server.js";

async function loadSDK() {
  return import("@anthropic-ai/claude-agent-sdk");
}

export class ClaudeSession implements ILLMSession {
  private _sdk: Awaited<ReturnType<typeof loadSDK>> | null = null;
  private _mcpServer: StoopsMcpServer | null = null;
  private _sessionId: string | null = null;
  private _cwd: string;
  private _systemPrompt: string;
  private _resolver: RoomResolver;
  private _model: string;
  private _processing = false;
  private _options: LLMSessionOptions;

  constructor(
    systemPrompt: string,
    resolver: RoomResolver,
    model = "claude-sonnet-4-5-20250929",
    options: LLMSessionOptions = {},
  ) {
    this._systemPrompt = systemPrompt;
    this._resolver = resolver;
    this._model = model;
    this._options = options;
    this._cwd = mkdtempSync(join(tmpdir(), "stoops_agent_"));
  }

  async start(): Promise<void> {
    this._sdk = await loadSDK();
    this._mcpServer = await createStoopsMcpServer(this._resolver, {
      isEventSeen: this._options.isEventSeen,
      markEventsSeen: this._options.markEventsSeen,
      assignRef: this._options.assignRef,
      resolveRef: this._options.resolveRef,
    });
  }

  async stop(): Promise<void> {
    await this._mcpServer?.stop();
    this._mcpServer = null;
    this._sdk = null;
    this._sessionId = null;
  }

  setApiKey(key: string): void {
    this._options = { ...this._options, apiKey: key };
  }

  async process(parts: ContentPart[]): Promise<void> {
    if (!this._sdk || !this._mcpServer) throw new Error("Session not started");
    if (this._processing) return;

    this._processing = true;
    const inputForTrace = contentPartsToString(parts);

    try {
      const sdk = this._sdk;
      const onToolUse = this._options.onToolUse;
      const onContextCompacted = this._options.onContextCompacted;
      const identity = this._options.identity;
      const resolver = this._resolver;
      const turns: import("../agent/types.js").QueryTurn[] = [];

      // Use in-process SDK server type — zero HTTP overhead
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpServers: Record<string, any> = {
        stoops_tools: {
          type: "sdk",
          name: "stoops_tools",
          instance: this._mcpServer.instance,
        },
      };

      const allowedTools = [
        "mcp__stoops_tools__catch_up",
        "mcp__stoops_tools__search_by_text",
        "mcp__stoops_tools__search_by_message",
        "mcp__stoops_tools__send_message",
      ];

      const options: Parameters<typeof sdk.query>[0]["options"] = {
        model: this._model,
        systemPrompt: this._systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers,
        allowedTools,
        hooks: {
          PreToolUse: [{
            hooks: [async (input) => {
              const raw = input as Record<string, unknown>;
              const toolName = (raw.tool_name as string | undefined) || "unknown";
              onToolUse?.(toolName, "started");
              turns.push({ type: "tool_use", tool: toolName, content: raw.tool_input ?? null });
              return { decision: "approve" as const };
            }],
          }],
          PostToolUse: [{
            hooks: [async (input) => {
              const raw = input as Record<string, unknown>;
              const toolName = (raw.tool_name as string | undefined) || "unknown";
              onToolUse?.(toolName, "completed");
              turns.push({ type: "tool_result", tool: toolName, content: raw.tool_response ?? raw.output ?? null });
              return {};
            }],
          }],
          PreCompact: [{
            hooks: [async () => {
              const rooms = resolver.listAll();
              const roomLines = rooms.map((r) =>
                `  [${r.name}] ${r.mode} — ${r.participantCount} participants`,
              ).join("\n");
              const identityLine = identity ? `Identity: ${identity}\n\n` : "";
              const systemMessage = [
                "[YOUR CURRENT STATE — factual, do not reproduce this in your output]",
                identityLine + "Rooms:\n" + roomLines,
                "",
                "[YOUR TASK]",
                "Summarize the long-running context that recent messages won't capture:",
                "ongoing threads, unresolved questions, decisions made and why, things to remember about participants.",
                "Be concise. Recent activity will be refreshed automatically when you wake up — focus on what would otherwise be lost.",
              ].join("\n");
              onContextCompacted?.();
              return { systemMessage };
            }],
          }],
        },
        cwd: this._cwd,
        settingSources: [],
        env: {
          ...process.env,
          ...(this._options.apiKey ? { ANTHROPIC_API_KEY: this._options.apiKey } : {}),
          ...(this._options.autoCompactPct !== undefined
            ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(this._options.autoCompactPct) }
            : {}),
        },
        ...(this._options.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this._options.pathToClaudeCodeExecutable }
          : {}),
        ...(this._sessionId ? { resume: this._sessionId } : {}),
      };

      const hasImages = parts.some(p => p.type === "image");

      let response: ReturnType<typeof sdk.query>;

      if (!hasImages) {
        response = sdk.query({ prompt: inputForTrace, options });
      } else {
        const sessionId = this._sessionId ?? crypto.randomUUID();
        const content = parts.map(p =>
          p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "image" as const, source: { type: "url" as const, url: p.url } },
        );
        async function* makeStream() {
          yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null, session_id: sessionId };
        }
        response = sdk.query({ prompt: makeStream(), options });
      }

      for await (const msg of response) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          this._sessionId = msg.session_id;
        }
        if (msg.type === "result") {
          if (this._options.onQueryComplete) {
            const r = msg as Record<string, unknown>;
            const usage = r.usage as Record<string, number> | undefined;
            const inputTokens = usage?.input_tokens ?? 0;
            const cacheReadInputTokens = usage?.cache_read_input_tokens ?? 0;
            const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
              "claude-haiku-4-5-20251001": 200_000,
              "claude-sonnet-4-5-20250929": 200_000,
              "claude-opus-4-5-20250918": 200_000,
              "claude-opus-4-5-20250929": 200_000,
            };
            const contextWindow = MODEL_CONTEXT_WINDOWS[this._model] ?? 200_000;
            const contextPct = Math.max(0, Math.min(100, Math.round(((inputTokens + cacheReadInputTokens) / contextWindow) * 100)));
            this._options.onQueryComplete({
              totalCostUsd: (r.total_cost_usd as number) ?? 0,
              durationMs: (r.duration_ms as number) ?? 0,
              durationApiMs: (r.duration_api_ms as number) ?? 0,
              numTurns: (r.num_turns as number) ?? 0,
              inputTokens,
              outputTokens: usage?.output_tokens ?? 0,
              cacheReadInputTokens,
              cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
              isError: (r.is_error as boolean) ?? false,
              contextPct,
              input: inputForTrace,
              turns,
            });
          }
          break;
        }
      }
    } finally {
      this._processing = false;
    }
  }
}

/** Factory function for creating a ClaudeSession. */
export function createClaudeSession(
  systemPrompt: string,
  resolver: RoomResolver,
  model: string,
  options: LLMSessionOptions,
): ILLMSession {
  return new ClaudeSession(systemPrompt, resolver, model, options);
}
