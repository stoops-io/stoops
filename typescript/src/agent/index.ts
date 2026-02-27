/** stoops/agent — agent orchestration framework. */

export { type ILLMSession } from "./types.js";
export { type RoomResolver, type RoomConnection, type LLMQueryStats, type LLMSessionOptions, type QueryTurn, type ContentPart } from "./types.js";
export { MODE_REMINDERS, formatEvent, participantLabel, messageRef, getSystemPreamble, contentPartsToString } from "./prompts.js";
export { EventProcessor, type EventProcessorOptions } from "./event-processor.js";
export { EventMultiplexer, type LabeledEvent } from "./multiplexer.js";
export { type EngagementMode, type EventDisposition, type EngagementStrategy, StoopsEngagement, classifyEvent } from "./engagement.js";
export { createStoopsMcpServer, type StoopsMcpServer } from "./mcp-server.js";
export { RefMap } from "./ref-map.js";
