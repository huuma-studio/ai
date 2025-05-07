import {
  type Candidate,
  type Content,
  type ContentListUnion,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
  type Schema,
} from "@google/genai";
import type {
  Message,
  ModelMessage,
  TextContent,
  Tool,
  ToolCallContent,
  ToolResultContent,
} from "@/mod.ts";
import type { BaseModel, ModelResult } from "@/model/mod.ts";
import type { JSONSchema } from "@huuma/validate";

type Gemini_2_0_Flash_Light =
  | "gemini-2.0-flash-lite"
  // Discontinuation date: February 25, 2026
  | "gemini-2.0-flash-lite-001";

type Gemini_2_0_Flash =
  | "gemini-2.0-flash"
  // Discontinuation date: February 5, 2026
  | "gemini-2.0-flash-001"
  // Discontinuation date: April 9, 2026
  | "gemini-2.0-flash-live-preview-04-09";

type Gemini_2_5_Flash = "gemini-2.5-flash-preview-04-17";

type Gemini_2_5_Pro =
  | "gemini-2.5-pro-preview-05-06"
  | "gemini-2.5-pro-exp-03-25";
type GeminiModels =
  | Gemini_2_0_Flash_Light
  | Gemini_2_0_Flash
  | Gemini_2_5_Flash
  | Gemini_2_5_Pro
  | `custom-${string}`;

interface GoogleGenAIOptions {
  apiKey: string;
}

interface GoogleGenAiGenerateOptions {
  modelId: GeminiModels;
  messages: Message[];
  system?: string;
  tools?: Tool[];
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
    const { candidates } = await this.#model.models.generateContent({
      model: parseModelId(modelId),
      contents: genAIContentsFrom(messages),
      config: {
        systemInstruction: system,
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

function parseModelId(modelId: GeminiModels): string {
  if (modelId.startsWith("custom-")) {
    return modelId.replace("custom-", "");
  }
  return modelId;
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

  for (const { text, functionCall } of parts) {
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
        message.contents.push({ toolCall });
      } else {
        console.info(
          "Tool call messages skipped because of missing tool call name",
        );
      }
    }
  }

  return [message];
}

function parametersFrom(jsonSchema: JSONSchema): Schema {
  // TODO: apply logic to comply with googles OpenApi based schema
  return jsonSchema as Schema;
}
