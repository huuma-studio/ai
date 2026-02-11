import {
  type Candidate,
  type Content,
  type ContentListUnion,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
  type Schema as JSONSchema,
} from "@google/genai";
import type {
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
  ToolResultContent,
} from "@/mod.ts";
import type { BaseModel, ModelResult } from "@/model/mod.ts";
import type { Schema } from "@huuma/validate";
import type { Tool } from "@/tools/mod.ts";

// Discontinuation date: April 9, 2026
type Gemini_2_0_Flash_Light = "gemini-2.0-flash-lite";
// Discontinuation date: April 9, 2026
type Gemini_2_0_Flash = "gemini-2.0-flash";
type Gemini_2_5_Flash_Light = "gemini-2.5-flash-lite";
type Gemini_2_5_Flash = "gemini-2.5-flash";
type Gemini_2_5_Pro = "gemini-2.5-pro";
type Gemini_3_Flash = "gemini-3-flash-preview";
type Gemini_3_Pro = "gemini-3-pro-preview";
type GeminiModels =
  | Gemini_2_0_Flash_Light
  | Gemini_2_0_Flash
  | Gemini_2_5_Flash_Light
  | Gemini_2_5_Flash
  | Gemini_2_5_Pro
  | Gemini_3_Flash
  | Gemini_3_Pro
  | string
    // deno-lint-ignore ban-types
    & {};

interface GoogleGenAIOptions {
  apiKey: string;
}

interface GoogleGenAiGenerateOptions {
  modelId: GeminiModels;
  messages: Message[];
  system?: string;
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];
}

export class GoogleGenAIModel implements BaseModel {
  #model: GoogleGenAI;

  constructor(options: GoogleGenAIOptions) {
    const { apiKey } = options;
    this.#model = new GoogleGenAI({ apiKey });
  }

  async generate(
    { modelId, messages, tools, system }: GoogleGenAiGenerateOptions,
  ): Promise<ModelResult<GeminiModels>> {
    const { candidates, usageMetadata } = await this.#model.models
      .generateContent({
        model: modelId,
        contents: genAIContentsFrom(messages),
        config: {
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
    console.log(usageMetadata);
    return modelResultFrom(modelId, messagesFrom(candidates));
  }

  async stream(
    { modelId, messages, tools }: GoogleGenAiGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<GeminiModels>>> {
    const stream = await this.#model.models.generateContentStream({
      model: modelId,
      contents: genAIContentsFrom(messages),
      config: {
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
  for await (const chunk of stream) {
    yield modelResultFrom(modelId, messagesFrom(chunk.candidates));
  }
}

export function google(options: GoogleGenAIOptions): GoogleGenAIModel {
  return new GoogleGenAIModel(options);
}

function modelResultFrom<T extends GeminiModels>(
  modelId: T,
  messages: Message[],
): ModelResult<T> {
  return { modelId, messages };
}

function genAIContentsFrom(messages: Message[]): ContentListUnion {
  return messages.map(genAIContentFrom);
}

function genAIContentFrom(message: Message): Content {
  return { role: message.role, parts: genAIPartsFrom(message.contents) };
}

function genAIPartsFrom(
  contents: (TextContent | ToolCallContent | ToolResultContent)[] | string,
): Part[] {
  return typeof contents === "string"
    ? [genAIPartFrom(contents)]
    : contents.map(genAIPartFrom);
}

function genAIPartFrom(
  content: TextContent | ToolCallContent | ToolResultContent | string,
): Part {
  if (typeof content === "string") {
    return { text: content };
  }

  if ("text" in content) {
    return { text: content.text };
  }

  if ("toolCall" in content) {
    const { id, name, props } = content.toolCall;
    return {
      thoughtSignature: content.reasoning,
      functionCall: { id, name, args: props },
    };
  }

  if ("toolResult" in content) {
    const { id, name, result } = content.toolResult;
    return { functionResponse: { id, name, response: result } };
  }

  throw RangeError();
}

function messagesFrom(
  candidates?: Candidate[],
): Message[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }

  const candidate = candidates[0];

  const message: ModelMessage = { role: "model", contents: [], toolCalls: [] };

  const parts = candidate.content?.parts || [];

  for (const { text, functionCall, thoughtSignature } of parts) {
    if (text) {
      message.contents.push({ text });
    }
    if (functionCall) {
      if (functionCall.name) {
        const toolCall: ToolCallContent["toolCall"] = {
          id: functionCall.id || crypto.randomUUID(),
          name: functionCall.name,
          props: functionCall.args || {},
        };
        message.toolCalls.push(toolCall);
        message.contents.push({ toolCall, reasoning: thoughtSignature });
      } else {
        console.info(
          "Tool call messages skipped because of missing tool call name",
        );
      }
    }
  }

  return [message];
}

// deno-lint-ignore no-explicit-any
function parametersFrom(schema: Schema<any>): JSONSchema {
  // TODO: apply logic to comply with googles OpenApi based schema
  return schema.jsonSchema() as JSONSchema;
}
