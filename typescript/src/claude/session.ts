/** Claude Agent SDK session backend for stoops agents. */

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RoomResolver, ClaudeSessionOptions, ILLMSession, ContentPart } from "../agent/types.js";
import { contentPartsToString } from "../agent/prompts.js";
import { createFullMcpServer, type StoopsMcpServer } from "../agent/mcp/index.js";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-haiku-4-5-20251001":  200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-opus-4-5-20250918":   200_000,
  "claude-opus-4-5-20250929":   200_000,
};

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
  private _options: ClaudeSessionOptions;

  constructor(
    systemPrompt: string,
    resolver: RoomResolver,
    model = "claude-sonnet-4-5-20250929",
    options: ClaudeSessionOptions = {},
  ) {
    this._systemPrompt = systemPrompt;
    this._resolver = resolver;
    this._model = model;
    this._options = options;
    this._cwd = mkdtempSync(join(tmpdir(), "stoops_agent_"));
  }

  async start(): Promise<void> {
    this._sdk = await loadSDK();
    this._mcpServer = await createFullMcpServer(this._resolver, {
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
    try { rmSync(this._cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  setApiKey(key: string): void {
    this._options = { ...this._options, apiKey: key };
  }

  async process(parts: ContentPart[]): Promise<void> {
    if (!this._sdk || !this._mcpServer) throw new Error("Session not started");
    if (this._processing) return;

    this._processing = true;
    const inputForTrace = contentPartsToString(parts);
    const turns: import("../agent/types.js").QueryTurn[] = [];

    try {
      const sdk = this._sdk;
      const onToolUse = this._options.onToolUse;
      const onContextCompacted = this._options.onContextCompacted;
      const identity = this._options.identity;
      const resolver = this._resolver;

      // Use in-process SDK server type — zero HTTP overhead
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpServers: Record<string, any> = {
        stoops: {
          type: "sdk",
          name: "stoops",
          instance: this._mcpServer.instance,
        },
      };

      const allowedTools = [
        "mcp__stoops__catch_up",
        "mcp__stoops__search_by_text",
        "mcp__stoops__search_by_message",
        "mcp__stoops__send_message",
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
              const toolName = ("tool_name" in input ? input.tool_name : undefined) || "unknown";
              onToolUse?.(toolName, "started");
              turns.push({ type: "tool_use", tool: toolName, content: "tool_input" in input ? input.tool_input : null });
              return { decision: "approve" as const };
            }],
          }],
          PostToolUse: [{
            hooks: [async (input) => {
              const toolName = ("tool_name" in input ? input.tool_name : undefined) || "unknown";
              onToolUse?.(toolName, "completed");
              turns.push({ type: "tool_result", tool: toolName, content: "tool_response" in input ? input.tool_response : null });
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
        if (msg.type === "system" && msg.subtype === "init") {
          this._sessionId = msg.session_id;
        }
        if (msg.type === "result") {
          if (this._options.onQueryComplete) {
            const inputTokens = msg.usage.input_tokens ?? 0;
            const cacheReadInputTokens = msg.usage.cache_read_input_tokens ?? 0;
            const contextWindow = MODEL_CONTEXT_WINDOWS[this._model] ?? 200_000;
            const contextPct = Math.max(0, Math.min(100, Math.round(((inputTokens + cacheReadInputTokens) / contextWindow) * 100)));
            this._options.onQueryComplete({
              totalCostUsd: msg.total_cost_usd ?? 0,
              durationMs: msg.duration_ms ?? 0,
              durationApiMs: msg.duration_api_ms ?? 0,
              numTurns: msg.num_turns ?? 0,
              inputTokens,
              outputTokens: msg.usage.output_tokens ?? 0,
              cacheReadInputTokens,
              cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
              isError: msg.is_error ?? false,
              contextPct,
              input: inputForTrace,
              turns,
            });
          }
          break;
        }
      }
    } catch (err) {
      if (this._options.onQueryComplete) {
        this._options.onQueryComplete({
          totalCostUsd: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          isError: true,
          contextPct: 0,
          input: inputForTrace,
          turns,
        });
      }
      throw err;
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
  options: ClaudeSessionOptions,
): ILLMSession {
  return new ClaudeSession(systemPrompt, resolver, model, options);
}
