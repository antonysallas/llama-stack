/**
 * Type definitions for the Llama Stack Responses API
 *
 * These types define the streaming events and response structures
 * used by the Responses API (replacing the deprecated Agents API).
 */

// Re-export types from llama-stack-client for convenience
export type {
  ResponseObject,
  ResponseObjectStream,
  ResponseCreateParams,
  ResponseCreateParamsStreaming,
  ResponseCreateParamsNonStreaming,
} from "llama-stack-client/resources/responses";

export type {
  ConversationObject,
  ConversationCreateParams,
} from "llama-stack-client/resources/conversations";

/**
 * MCP Tool configuration for Responses API
 * Both server_label and server_url are required
 */
export interface MCPToolConfig {
  type: "mcp";
  server_label: string;
  server_url: string;
  allowed_tools?: string[];
}

/**
 * Function tool configuration for Responses API
 */
export interface FunctionToolConfig {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Web search tool configuration
 */
export interface WebSearchToolConfig {
  type: "web_search";
}

/**
 * File search tool configuration
 */
export interface FileSearchToolConfig {
  type: "file_search";
  vector_store_ids?: string[];
}

export type ToolConfig =
  | MCPToolConfig
  | FunctionToolConfig
  | WebSearchToolConfig
  | FileSearchToolConfig;

/**
 * Stream event types for the Responses API
 * These map to the ResponseObjectStream union type from the client
 */
export type ResponseStreamEventType =
  | "response.created"
  | "response.in_progress"
  | "response.output_item.added"
  | "response.output_item.done"
  | "response.output_text.delta"
  | "response.output_text.done"
  | "response.function_call_arguments.delta"
  | "response.function_call_arguments.done"
  | "response.mcp_call.arguments.delta"
  | "response.mcp_call.arguments.done"
  | "response.mcp_call.in_progress"
  | "response.mcp_call.failed"
  | "response.mcp_call.completed"
  | "response.mcp_list_tools.in_progress"
  | "response.mcp_list_tools.failed"
  | "response.mcp_list_tools.completed"
  | "response.web_search_call.in_progress"
  | "response.web_search_call.searching"
  | "response.web_search_call.completed"
  | "response.content_part.added"
  | "response.content_part.done"
  | "response.reasoning_text.delta"
  | "response.reasoning_text.done"
  | "response.incomplete"
  | "response.failed"
  | "response.completed";

/**
 * Helper type guard for checking stream event types
 */
export function isTextDeltaEvent(
  event: { type?: string }
): event is { type: "response.output_text.delta"; delta: string; item_id: string } {
  return event.type === "response.output_text.delta";
}

export function isCompletedEvent(
  event: { type?: string }
): event is { type: "response.completed"; response: unknown } {
  return event.type === "response.completed";
}

export function isMCPCallCompletedEvent(
  event: { type?: string }
): event is { type: "response.mcp_call.completed" } {
  return event.type === "response.mcp_call.completed";
}

export function isMCPCallInProgressEvent(
  event: { type?: string }
): event is { type: "response.mcp_call.in_progress" } {
  return event.type === "response.mcp_call.in_progress";
}

export function isOutputItemAddedEvent(
  event: { type?: string }
): event is { type: "response.output_item.added"; item: unknown } {
  return event.type === "response.output_item.added";
}

export function isOutputItemDoneEvent(
  event: { type?: string }
): event is { type: "response.output_item.done"; item: unknown } {
  return event.type === "response.output_item.done";
}

/**
 * Mapping from old Agents API event types to new Responses API event types
 * Useful for understanding the migration
 */
export const EVENT_TYPE_MAPPING = {
  // Old → New
  turn_start: "response.created",
  step_start: "response.output_item.added",
  step_progress_text: "response.output_text.delta",
  step_progress_tool: "response.mcp_call.arguments.delta",
  step_complete: "response.output_item.done",
  turn_complete: "response.completed",
} as const;

/**
 * Message role types
 */
export type MessageRole = "system" | "user" | "assistant" | "developer";

/**
 * Input message format for Responses API
 */
export interface ResponseInputMessage {
  role: MessageRole;
  content: string | ContentPart[];
}

/**
 * Content part for multimodal messages
 */
export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
  | { type: "input_file"; file_id: string };

/**
 * Parameters for creating a response with the new API
 */
export interface CreateResponseParams {
  model: string;
  input: string | ResponseInputMessage[];
  instructions?: string;
  conversation?: string;
  previousResponseId?: string;
  tools?: ToolConfig[];
  stream?: boolean;
  temperature?: number;
  maxInferIters?: number;
  store?: boolean;
}

/**
 * Extracted text content from a streaming response
 */
export interface StreamingTextAccumulator {
  text: string;
  itemId: string | null;
  isComplete: boolean;
}

/**
 * Tool call information from MCP
 */
export interface MCPToolCall {
  id: string;
  serverLabel: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: "in_progress" | "completed" | "failed";
  result?: unknown;
  error?: string;
}
