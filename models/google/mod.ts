/**
 * Google Gemini model adapter for the Huuma AI model interface.
 *
 * @example
 * ```typescript
 * import { google } from "jsr:@huuma/ai/models/google";
 *
 * const model = google({ apiKey: Deno.env.get("GOOGLE_API_KEY") });
 * const result = await model.generate({
 *   modelId: "gemini-2.5-flash",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 *
 * @module
 */
import {
  type Candidate,
  type Content,
  type ContentListUnion,
  FinishReason,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  GoogleGenAI,
  type Part,
  type Schema as JSONSchema,
  type ThinkingConfig,
} from "@google/genai";
import type {
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
  ToolResultContent,
} from "@/mod.ts";
import type { BaseModel, ModelResult, ModelUsage } from "@/model/mod.ts";
import type { Schema } from "@huuma/validate";
import type { Tool } from "@/tools/mod.ts";

// Shutdown date: October 16, 2026
type Gemini_2_5_Flash_Light = "gemini-2.5-flash-lite";
// Shutdown date: October 16, 2026
type Gemini_2_5_Flash = "gemini-2.5-flash";
// Shutdown date: October 16, 2026
type Gemini_2_5_Pro = "gemini-2.5-pro";

// No shutdown date announced
type Gemini_3_Flash_Preview = "gemini-3-flash-preview";
// No shutdown date announced
type Gemini_3_1_Pro_Preview = "gemini-3-1-pro-preview";
// Shutdown date: May 7, 2027
type Gemini_3_1_Flash_Lite = "gemini-3.1-flash-lite";
// No shutdown date announced
type Gemini_3_5_Flash = "gemini-3.5-flash";

/**
 * Google Gemini model identifiers.
 *
 * Known aliases are listed for autocompletion, while the open string branch
 * keeps the wrapper usable with newly released models.
 */
export type GeminiModels =
  | Gemini_2_5_Flash_Light
  | Gemini_2_5_Flash
  | Gemini_2_5_Pro
  | Gemini_3_Flash_Preview
  | Gemini_3_1_Pro_Preview
  | Gemini_3_1_Flash_Lite
  | Gemini_3_5_Flash
  | string
    // deno-lint-ignore ban-types
    & {};

/** Options for configuring the Google GenAI client. */
export interface GoogleGenAIOptions {
  /** Google API key. */
  apiKey: string;
}

/** Options for generating content with Gemini. */
export interface GoogleGenAiGenerateOptions {
  /** The model identifier to use. */
  modelId: GeminiModels;
  /** Conversation history. */
  messages: Message[];
  /** Optional system prompt sent as Gemini's `systemInstruction`. */
  system?: string;
  /** Tools available to the model. */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];
  /** Additional Gemini generation options. */
  options?: {
    /** Thinking/reasoning configuration. */
    thinkingConfig?: ThinkingConfig;
  };
}

/** Google Gemini adapter implementing the common model interface. */
export class GoogleGenAIModel implements BaseModel {
  #model: GoogleGenAI;

  /**
   * Create a new Google GenAI model adapter.
   *
   * @param options Configuration including the Google API key.
   */
  constructor(options: GoogleGenAIOptions) {
    const { apiKey } = options;
    this.#model = new GoogleGenAI({ apiKey });
  }

  /** Generate a complete Gemini response. */
  async generate(
    { modelId, messages, tools, system, options }: GoogleGenAiGenerateOptions,
  ): Promise<ModelResult<GeminiModels>> {
    const response = await this.#model.models
      .generateContent({
        model: modelId,
        contents: genAIContentsFrom(messages),
        config: {
          thinkingConfig: options?.thinkingConfig,
          systemInstruction: system,
          tools: tools?.length
            ? [{
              functionDeclarations: tools.map((
                { name, description, input },
              ) => ({
                name,
                description,
                parameters: parametersFrom(input),
              })),
            }]
            : undefined,
        },
      });
    return modelResultFrom(
      modelId,
      modelMessagesFrom(response),
      googleUsageFrom(response.usageMetadata),
    );
  }

  /** Stream Gemini responses as normalized model results.
   *
   * The stream ends with a usage-only {@link ModelResult} (empty `messages`)
   * carrying the token usage of the whole call, taken from the last chunk
   * that reported usage metadata.
   */
  async stream(
    { modelId, messages, tools, system, options }: GoogleGenAiGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<GeminiModels>>> {
    const stream = await this.#model.models.generateContentStream({
      model: modelId,
      contents: genAIContentsFrom(messages),
      config: {
        systemInstruction: system,
        thinkingConfig: options?.thinkingConfig,
        tools: tools?.length
          ? [{
            functionDeclarations: tools.map(({ name, description, input }) => ({
              name,
              description,
              parameters: parametersFrom(input),
            })),
          }]
          : undefined,
      },
    });
    return streamMessages(stream, modelId);
  }
}

async function* streamMessages(
  stream: AsyncGenerator<GenerateContentResponse>,
  modelId: GeminiModels,
) {
  // Gemini reports cumulative usage on chunks as the stream progresses;
  // the last reported metadata covers the whole call.
  let usage: ModelUsage | undefined;

  for await (const chunk of stream) {
    usage = googleUsageFrom(chunk.usageMetadata) ?? usage;

    const messages = messagesFrom(chunk.candidates);
    if (messages.length) {
      yield modelResultFrom(modelId, messages);
    }
  }

  if (usage) {
    yield modelResultFrom(modelId, [], usage);
  }
}

/** Maps Gemini usage metadata to the normalized {@link ModelUsage}. */
export function googleUsageFrom(
  metadata: GenerateContentResponseUsageMetadata | undefined,
): ModelUsage | undefined {
  if (!metadata) {
    return undefined;
  }

  const result: ModelUsage = {};
  if (metadata.promptTokenCount !== undefined) {
    result.inputTokens = metadata.promptTokenCount;
  }
  if (metadata.candidatesTokenCount !== undefined) {
    result.outputTokens = metadata.candidatesTokenCount;
  }
  if (metadata.totalTokenCount !== undefined) {
    result.totalTokens = metadata.totalTokenCount;
  }
  if (metadata.cachedContentTokenCount !== undefined) {
    result.cacheReadInputTokens = metadata.cachedContentTokenCount;
  }
  if (metadata.thoughtsTokenCount !== undefined) {
    result.thinkingTokens = metadata.thoughtsTokenCount;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Create a Google Gemini model adapter.
 *
 * @param options Google API key and other client options.
 * @returns A {@link GoogleGenAIModel} instance.
 */
export function google(options: GoogleGenAIOptions): GoogleGenAIModel {
  return new GoogleGenAIModel(options);
}

function modelResultFrom<T extends GeminiModels>(
  modelId: T,
  messages: Message[],
  usage?: ModelUsage,
): ModelResult<T> {
  return usage ? { modelId, messages, usage } : { modelId, messages };
}

/** Convert shared messages into Gemini request contents.
 *
 * Gemini only accepts the roles `"user"` and `"model"`: system messages in
 * history are sent as user content, and tool messages become user content
 * carrying `functionResponse` parts. Thought signatures captured in
 * `thinkingMeta.thoughtSignatures` are re-attached to their matching parts.
 */
export function genAIContentsFrom(messages: Message[]): ContentListUnion {
  return messages.map(genAIContentFrom);
}

function genAIContentFrom(message: Message): Content {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: genAIPartsFrom(
        message.contents.filter((content) => "toolResult" in content),
      ),
    };
  }

  if (message.role === "model") {
    const thoughtSignatures = thoughtSignaturesFrom(message);
    return {
      role: "model",
      parts: message.contents.map((content, index) =>
        genAIPartFrom(content, thoughtSignatures?.[index])
      ),
    };
  }

  return {
    role: "user",
    parts: genAIPartsFrom(message.contents),
  };
}

function thoughtSignaturesFrom(
  message: ModelMessage,
): (string | undefined)[] | undefined {
  const signatures = message.thinkingMeta?.thoughtSignatures;
  return Array.isArray(signatures) ? signatures : undefined;
}

function genAIPartsFrom(
  contents: (TextContent | ToolCallContent | ToolResultContent)[] | string,
): Part[] {
  return typeof contents === "string"
    ? [genAIPartFrom(contents)]
    : contents.map((content) => genAIPartFrom(content));
}

function genAIPartFrom(
  content: TextContent | ToolCallContent | ToolResultContent | string,
  thoughtSignature?: string,
): Part {
  if (typeof content === "string") {
    return { text: content };
  }

  if ("text" in content) {
    return thoughtSignature
      ? { thoughtSignature, text: content.text }
      : { text: content.text };
  }

  if ("toolCall" in content) {
    const { id, name, props } = content.toolCall;
    return {
      thoughtSignature,
      functionCall: { id, name, args: props },
    };
  }

  if ("toolResult" in content) {
    const { id, name, result } = content.toolResult;
    return { functionResponse: { id, name, response: result } };
  }

  throw new RangeError("Unsupported message content for Gemini part");
}

/** Convert a Gemini response into model messages.
 *
 * Throws when the prompt was blocked (no candidates returned) or when the
 * candidate carries no content for a reason other than a normal stop, so
 * blocked or truncated responses fail loudly instead of resolving empty.
 */
export function modelMessagesFrom(
  response: GenerateContentResponse,
): ModelMessage[] {
  const candidate = response.candidates?.at(0);
  if (!candidate) {
    const blockReason = response.promptFeedback?.blockReason;
    throw new Error(
      `No candidates returned from Gemini${
        blockReason ? ` (block reason: ${blockReason})` : ""
      }`,
    );
  }

  const messages = messagesFrom(response.candidates);
  if (
    !messages.length && candidate.finishReason &&
    candidate.finishReason !== FinishReason.STOP
  ) {
    throw new Error(
      `Gemini returned no content (finish reason: ${candidate.finishReason})`,
    );
  }

  return messages;
}

function messagesFrom(
  candidates?: Candidate[],
): ModelMessage[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }

  const candidate = candidates[0];

  const message: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };
  const thoughtSignatures: (string | undefined)[] = [];
  // Signatures can arrive on thought parts, which are not round-tripped
  // themselves; carry them over to the next content-bearing part.
  let pendingSignature: string | undefined;

  const parts = candidate.content?.parts || [];

  for (
    const { text, functionCall, thoughtSignature, thought } of parts
  ) {
    if (thoughtSignature) {
      pendingSignature = thoughtSignature;
    }

    if (thought) {
      if (text) {
        message.thinking = (message.thinking ?? "") + text;
      }
      continue;
    }

    if (text) {
      message.contents.push({ text });
      thoughtSignatures.push(pendingSignature);
      pendingSignature = undefined;
    }
    if (functionCall) {
      if (functionCall.name) {
        const toolCall: ToolCallContent["toolCall"] = {
          id: functionCall.id || crypto.randomUUID(),
          name: functionCall.name,
          props: functionCall.args || {},
        };
        message.toolCalls.push(toolCall);
        message.contents.push({ toolCall });
        thoughtSignatures.push(pendingSignature);
        pendingSignature = undefined;
      } else {
        console.info(
          "Tool call messages skipped because of missing tool call name",
        );
      }
    }
  }

  if (thoughtSignatures.some((signature) => signature !== undefined)) {
    message.thinkingMeta = { thoughtSignatures };
  }

  if (
    message.contents.length === 0 && message.toolCalls.length === 0 &&
    message.thinking === undefined
  ) {
    return [];
  }

  return [message];
}

// deno-lint-ignore no-explicit-any
function parametersFrom(schema: Schema<any>): JSONSchema {
  // TODO: apply logic to comply with googles OpenApi based schema
  return schema.jsonSchema() as JSONSchema;
}
