/**
 * LangGraph-based LLM session backend for stoops agents.
 *
 * Connects to the stoops MCP server via HTTP URL (same server as Claude backend).
 * Uses a custom StateGraph with inject/agent/tools nodes.
 */

import type { RoomResolver, LangGraphSessionOptions, ILLMSession, ContentPart, QueryTurn } from "../agent/types.js";
import { contentPartsToString } from "../agent/prompts.js";
import { createStoopsMcpServer, type StoopsMcpServer } from "../agent/mcp-server.js";

// ── Token pricing table (approximate, USD per 1M tokens) ─────────────────────
// Last updated: 2026-02. Add new models as they launch.
// Unknown models return cost 0 — callers should not rely on this for billing.

const TOKEN_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5-20251001":  { input: 0.8,  output: 4.0 },
  "claude-opus-4-5-20250918":   { input: 15.0, output: 75.0 },
  "claude-opus-4-5-20250929":   { input: 15.0, output: 75.0 },
  "gpt-4o":                     { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":                { input: 0.15, output: 0.6 },
  "o3":                         { input: 10.0, output: 40.0 },
  "o3-mini":                    { input: 1.1,  output: 4.4 },
  "gemini-2.0-flash":           { input: 0.1,  output: 0.4 },
  "gemini-2.5-pro":             { input: 1.25, output: 10.0 },
};

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-haiku-4-5-20251001":  200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-opus-4-5-20250918":   200_000,
  "claude-opus-4-5-20250929":   200_000,
  "gpt-4o":         128_000,
  "gpt-4o-mini":    128_000,
  "o3":             200_000,
  "o3-mini":        200_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro":   1_000_000,
};

function estimateCost(modelName: string, inputTokens: number, outputTokens: number): number {
  const bare = modelName.includes(":") ? modelName.split(":").pop()! : modelName;
  const pricing = TOKEN_PRICING[bare];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function getContextWindow(modelName: string): number {
  const bare = modelName.includes(":") ? modelName.split(":").pop()! : modelName;
  return MODEL_CONTEXT_WINDOWS[bare] ?? 200_000;
}

export class LangGraphSession implements ILLMSession {
  private _systemPrompt: string;
  private _resolver: RoomResolver;
  private _model: string;
  private _options: LangGraphSessionOptions;
  private _threadId: string;
  private _processing = false;
  private _mcpServer: StoopsMcpServer | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _mcpClient: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _graph: any = null;

  constructor(
    systemPrompt: string,
    resolver: RoomResolver,
    model: string,
    options: LangGraphSessionOptions = {},
  ) {
    this._systemPrompt = systemPrompt;
    this._resolver = resolver;
    this._model = model;
    this._options = options;
    this._threadId = crypto.randomUUID();
  }

  async start(): Promise<void> {
    // Validate LangChain dependencies are installed (they're optional in package.json)
    try {
      await import("@langchain/langgraph");
    } catch {
      throw new Error(
        "LangGraph backend requires @langchain/langgraph, @langchain/core, @langchain/mcp-adapters, and langchain. " +
        "Install them with: npm install @langchain/langgraph @langchain/core @langchain/mcp-adapters langchain @langchain/anthropic",
      );
    }

    // Start the shared stoops MCP server
    this._mcpServer = await createStoopsMcpServer(this._resolver, {
      isEventSeen: this._options.isEventSeen,
      markEventsSeen: this._options.markEventsSeen,
      assignRef: this._options.assignRef,
      resolveRef: this._options.resolveRef,
    });

    const mcpUrl = this._mcpServer.url;

    const { StateGraph, MemorySaver, MessagesValue, START, END } = await import("@langchain/langgraph");
    const { StateSchema } = await import("@langchain/langgraph");
    const { initChatModel } = await import("langchain/chat_models/universal");
    const { ToolNode } = await import("@langchain/langgraph/prebuilt");
    const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");

    // Connect to stoops MCP server via HTTP.
    // MultiServerMCPClient's type doesn't accept arbitrary string keys for server
    // names in its config, but the runtime API does. We assert the config shape
    // precisely and then cast to the constructor's parameter type.
    const mcpConfig = {
      servers: {
        stoops_tools: {
          transport: "streamable_http" as const,
          url: mcpUrl,
        },
      },
    };
    this._mcpClient = new MultiServerMCPClient(
      mcpConfig as unknown as ConstructorParameters<typeof MultiServerMCPClient>[0],
    );

    const tools = await this._mcpClient.getTools();

    const llm = await initChatModel(this._model, {
      temperature: 0,
      ...(this._options.apiKey ? { apiKey: this._options.apiKey } : {}),
    });
    const llmWithTools = llm.bindTools(tools);

    const AgentState = new StateSchema({
      messages: MessagesValue,
    });

    const options = this._options;

    // inject node: drains mid-loop event buffer between tool rounds.
    // Events are already pre-formatted by the runtime (timestamps, room labels,
    // participant icons) — we just extract the text from ContentPart[].
    const injectNode = async (state: { messages: unknown[] }) => {
      const drained = options.drainEventQueue?.();
      if (!drained || drained.length === 0) return {};
      const { HumanMessage } = await import("@langchain/core/messages");
      const lines = ["While you were responding, this happened:\n"];
      for (const parts of drained) {
        for (const part of parts) {
          if (part.type === "text") lines.push(part.text);
        }
      }
      return { messages: [new HumanMessage({ content: lines.join("\n") })] };
    };

    const agentNode = async (state: { messages: unknown[] }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await llmWithTools.invoke(state.messages as any);
      return { messages: [response] };
    };

    const toolNode = new ToolNode(tools);
    const toolsNodeWrapped = async (state: { messages: unknown[] }) => {
      const lastMsg = state.messages[state.messages.length - 1] as { tool_calls?: Array<{ name: string }> };
      const toolCalls = lastMsg?.tool_calls ?? [];
      for (const tc of toolCalls) options.onToolUse?.(tc.name, "started");
      const result = await toolNode.invoke(state);
      for (const tc of toolCalls) options.onToolUse?.(tc.name, "completed");
      return result;
    };

    const shouldContinue = (state: { messages: unknown[] }) => {
      const lastMsg = state.messages[state.messages.length - 1] as { tool_calls?: unknown[] };
      return lastMsg?.tool_calls && (lastMsg.tool_calls as unknown[]).length > 0 ? "tools" : END;
    };

    const checkpointer = new MemorySaver();

    this._graph = new StateGraph(AgentState)
      .addNode("inject", injectNode)
      .addNode("agent", agentNode)
      .addNode("tools", toolsNodeWrapped)
      .addEdge(START, "inject")
      .addEdge("inject", "agent")
      .addConditionalEdges("agent", shouldContinue, ["tools", END])
      .addEdge("tools", "inject")
      .compile({ checkpointer });
  }

  async stop(): Promise<void> {
    try { await this._mcpClient?.close?.(); } catch { /* best effort */ }
    this._mcpClient = null;
    await this._mcpServer?.stop();
    this._mcpServer = null;
    this._graph = null;
  }

  setApiKey(key: string): void {
    this._options = { ...this._options, apiKey: key };
  }

  async process(parts: ContentPart[]): Promise<void> {
    if (!this._graph) throw new Error("Session not started");
    if (this._processing) return;
    this._processing = true;

    const inputForTrace = contentPartsToString(parts);
    const startTime = Date.now();
    const turns: QueryTurn[] = [];

    try {
      const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");

      const messageContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const part of parts) {
        if (part.type === "text") {
          messageContent.push({ type: "text", text: part.text });
        } else {
          messageContent.push({ type: "image_url", image_url: { url: part.url } });
        }
      }

      const state = await this._graph.getState({ configurable: { thread_id: this._threadId } });
      const existingMessageCount = state?.values?.messages?.length ?? 0;
      const isFirstInvocation = existingMessageCount === 0;

      const inputMessages: unknown[] = [];
      if (isFirstInvocation) {
        inputMessages.push(new SystemMessage({ content: this._systemPrompt }));
      }
      inputMessages.push(new HumanMessage({ content: messageContent }));

      const result = await this._graph.invoke(
        { messages: inputMessages },
        { configurable: { thread_id: this._threadId } },
      );

      const allMessages = result.messages ?? [];
      // Only count new messages from this invocation (skip historical ones)
      const resultMessages = allMessages.slice(existingMessageCount);
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let numTurns = 0;

      // Token usage field names vary by provider:
      //   Anthropic: usage_metadata.{input_tokens, output_tokens}
      //   OpenAI:    response_metadata.usage.{prompt_tokens, completion_tokens}
      for (const msg of resultMessages) {
        const usage = msg?.usage_metadata ?? msg?.response_metadata?.usage;
        if (usage) {
          totalInputTokens += usage.input_tokens ?? usage.prompt_tokens ?? 0;
          totalOutputTokens += usage.output_tokens ?? usage.completion_tokens ?? 0;
          numTurns++;
        }
        if (msg?.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            turns.push({ type: "tool_use", tool: tc.name, content: tc.args });
          }
        }
        if (msg?.role === "tool" || msg?._getType?.() === "tool") {
          turns.push({ type: "tool_result", tool: msg.name ?? "unknown", content: msg.content });
        }
      }

      const contextWindow = getContextWindow(this._model);
      const autoCompactPct = this._options.autoCompactPct ?? 80;
      const usagePct = Math.round((totalInputTokens / contextWindow) * 100);
      if (usagePct >= autoCompactPct) this._options.onContextCompacted?.();

      if (this._options.onQueryComplete) {
        const durationMs = Date.now() - startTime;
        this._options.onQueryComplete({
          totalCostUsd: estimateCost(this._model, totalInputTokens, totalOutputTokens),
          durationMs,
          durationApiMs: durationMs,
          numTurns,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          isError: false,
          contextPct: Math.max(0, Math.min(100, usagePct)),
          input: inputForTrace,
          turns,
        });
      }
    } catch (err) {
      if (this._options.onQueryComplete) {
        this._options.onQueryComplete({
          totalCostUsd: 0,
          durationMs: Date.now() - startTime,
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

export function createLangGraphSession(
  systemPrompt: string,
  resolver: RoomResolver,
  model: string,
  options: LangGraphSessionOptions,
): ILLMSession {
  return new LangGraphSession(systemPrompt, resolver, model, options);
}
