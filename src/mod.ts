import type { JSONSchema } from "@huuma/validate";

/**
 * Shared message and content types used by Huuma AI model adapters, agents,
 * workflows, and tools.
 *
 * @example
 * ```typescript
 * import type { Message } from "jsr:@huuma/ai";
 *
 * const message: Message = {
 *   role: "user",
 *   contents: "Hello!",
 * };
 * ```
 *
 * @module
 */

/** Conversation message exchanged between users, models, systems, and tools. */
export type Message =
  | SystemMessage
  | ModelMessage
  | UserMessage
  | ToolMessage;

/** Supported message roles. */
export type MessageRole = "system" | "user" | "model" | "tool";

/** Base shape for messages that carry a role. */
export interface MessageWithRole {
  /** The role of the message author. */
  role: MessageRole;
}

/** System instruction message. */
export interface SystemMessage extends MessageWithRole {
  /** System message role. */
  role: "system";
  /** System instruction text, either as a string or text parts. */
  contents: string | TextContent[];
}

/** Assistant/model response message. */
export interface ModelMessage extends MessageWithRole {
  /** Model message role. */
  role: "model";
  /** Text and tool-call content produced by the model. */
  contents: (TextContent | ToolCallContent)[];
  /** Normalized tool calls requested by the model. */
  toolCalls: ToolCallContent["toolCall"][];
  /** Optional reasoning or thinking text exposed by supported providers. */
  thinking?: string;
  /** Provider-specific metadata needed to round-trip thinking state. */
  thinkingMeta?: Record<string, unknown | string | null | undefined>;
}

/** User input message. */
export interface UserMessage extends MessageWithRole {
  /** User message role. */
  role: "user";
  /** User text, either as a string or text parts. */
  contents: string | TextContent[];
}

/** Tool response message. */
export interface ToolMessage extends MessageWithRole {
  /** Tool message role. */
  role: "tool";
  /** Tool calls and their corresponding results. */
  contents: (ToolCallContent | ToolResultContent)[];
}

/** Plain text content part. */
export type TextContent = { text: string };

/** Tool call content part emitted by a model. */
export type ToolCallContent<T = JSONSchema> = {
  /** Tool call payload. */
  toolCall: {
    /** Provider or locally generated tool call identifier. */
    id: string;
    /** Tool name to invoke. */
    name: string;
    /** Tool input properties. */
    props: T;
  };
};

/** Tool result content part returned after tool execution. */
export type ToolResultContent<T = unknown> = {
  /** Tool result payload. */
  toolResult: {
    /** Identifier of the tool call this result answers. */
    id: string;
    /** Tool name that produced the result. */
    name: string;
    /** Tool execution result. */
    result: {
      /** Successful tool output. */
      output?: T;
      /** Tool execution error. */
      error?: unknown;
    };
  };
};
