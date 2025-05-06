import type { Message } from "../mod.ts";

export interface BaseModel<T extends string = string> {
  generate(args: unknown): Promise<ModelResult<T>>;
  stream(args: unknown): Promise<AsyncGenerator<ModelResult>>;
}

export interface ModelResult<T extends string = string> {
  modelId: T;
  messages: Message[];
}
