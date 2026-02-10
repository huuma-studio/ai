import type { JSONSchema } from "@huuma/validate";

export type Message =
  | SytemMessage
  | ModelMessage
  | UserMessage
  | ToolMessage;

const Role = ["system", "user", "model", "tool"] as const;

export type MessageRole = typeof Role[number];

export interface MessageWithRole {
  role: MessageRole;
}

export interface SytemMessage extends MessageWithRole {
  role: "system";
  contents: string | TextContent[];
}

export interface ModelMessage extends MessageWithRole {
  role: "model";
  contents: (TextContent | ToolCallContent)[];
  toolCalls: ToolCallContent["toolCall"][];
}

export interface UserMessage extends MessageWithRole {
  role: "user";
  contents: string | TextContent[];
}

export interface ToolMessage extends MessageWithRole {
  role: "tool";
  contents: (ToolCallContent | ToolResultContent)[];
}

export type TextContent = { text: string };

export type ToolCallContent<T = JSONSchema> = {
  toolCall: {
    id: string;
    name: string;
    props: T;
  };
  reasoning?: string;
};

export type ToolResultContent<T = unknown> = {
  toolResult: {
    id: string;
    name: string;
    result: {
      output?: T;
      error?: unknown;
    };
  };
};
