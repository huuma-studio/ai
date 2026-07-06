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
 * @example User message carrying a file next to text. A file part holds
 * an IANA MIME type plus either base64 `data` or a publicly reachable
 * `url` (exactly one of the two); provider support depends on the model
 * adapter, and unsupported combinations throw at request time.
 * ```typescript
 * import type { Message } from "jsr:@huuma/ai";
 *
 * const message: Message = {
 *   role: "user",
 *   contents: [
 *     { text: "What is in this image?" },
 *     { file: { mimeType: "image/png", data: "aGVsbG8=" } },
 *   ],
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
  /** User text, either as a string or text and file parts. */
  contents: string | (TextContent | FileContent)[];
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

/** Media/file content part. */
export type FileContent = {
  /** File payload. */
  file: {
    /** IANA MIME type, e.g. "image/png", "application/pdf". */
    mimeType: string;
    /**
     * Base64-encoded bytes (no data-URL prefix). Exactly one of
     * `data`/`url` must be set; adapters enforce this at runtime.
     */
    data?: string;
    /** Publicly reachable URL. */
    url?: string;
    /** Optional file name (OpenAI requires one for PDF input). */
    name?: string;
  };
};

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
    /**
     * Media attached to the result. Delivery is provider-dependent:
     * native tool-result content blocks where the API supports them, a
     * synthetic user message elsewhere (ADR 0004). Adapters throw
     * {@linkcode RangeError} on unsupported mimeType/source combinations
     * rather than silently dropping files.
     */
    files?: FileContent[];
  };
};
