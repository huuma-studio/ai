/**
 * Ollama model adapter for the Huuma AI model interface.
 *
 * @example
 * ```typescript
 * import { ollama } from "jsr:@huuma/ai/models/ollama";
 *
 * const model = ollama({ host: "http://localhost:11434" });
 * const result = await model.generate({
 *   modelId: "llama3.2",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 *
 * @module
 */
import { type ChatResponse, Ollama } from "ollama";
import type { BaseModel, ModelResult, ModelUsage } from "@/model/mod.ts";
import type {
  FileContent,
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
} from "@/mod.ts";
import { fileSourceFrom, toolFilesLabel } from "@/model/mod.ts";
import type { Tool } from "@/tools/mod.ts";
import type { Message as OllamaMessage, Tool as OllamaTool } from "ollama";
/**
 * Ollama models currently available.
 * This list is not exhaustive as Ollama models can be pulled dynamically.
 */
export type OllamaModels = // deno-lint-ignore ban-types
  string & {};

/**
 * Options for configuring the Ollama client.
 */
export interface OllamaOptions {
  /**
   * The host URL for the Ollama instance.
   * Defaults to "http://localhost:11434".
   *
   * When using an API key, it is strongly recommended to use HTTPS
   * to prevent credential leakage over the network.
   */
  host?: string;

  /**
   * API Key for Ollama Cloud or other authenticated instances.
   *
   * **Security Warning:**
   * - Never hardcode API keys in source code
   * - Use the `OLLAMA_API_KEY` environment variable instead of passing
   *   the key directly when possible
   * - Ensure the host URL uses HTTPS (except for localhost)
   * - Rotate keys regularly according to your security policy
   *
   * If not provided, falls back to `OLLAMA_API_KEY` environment variable.
   */
  apiKey?: string;
}

/**
 * Options for generating content with Ollama.
 */
export interface OllamaGenerateOptions {
  /**
   * The model to use.
   */
  modelId: OllamaModels;

  /**
   * The messages to send to the model.
   */
  messages: Message[];

  /**
   * System prompt (optional).
   */
  system?: string;

  /**
   * Tools available to the model (optional).
   */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];

  /**
   * Additional model parameters (temperature, top_p, etc).
   */
  options?: Record<string, unknown>;

  /**
   * Response format (e.g., "json").
   */
  format?: string;

  /**
   * Controls how long the model will stay loaded into memory following the request (default: 5m).
   */
  keep_alive?: string | number;
}

/**
 * Ollama adapter implementing the common {@link BaseModel} interface.
 */
export class OllamaModel implements BaseModel<OllamaModels> {
  private client: Ollama;
  private host?: string;

  /**
   * Creates a new OllamaModel instance.
   *
   * @param options - Configuration options including host and API key.
   */
  constructor(options?: OllamaOptions) {
    const apiKey = resolveApiKey(options);
    const host = options?.host;
    // Validate security before creating client
    assertValidHostUrl(options?.host, !!apiKey);

    this.client = new Ollama({
      host,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
  }

  /**
   * Generate a complete chat response via Ollama.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns A normalized {@link ModelResult}.
   */
  async generate(
    options: OllamaGenerateOptions,
  ): Promise<ModelResult<OllamaModels>> {
    const messages = ollamaMessagesFrom(options.messages);

    if (options.system) {
      messages.unshift({ role: "system", content: options.system });
    }

    const tools = options.tools ? ollamaToolsFrom(options.tools) : undefined;

    const response = await this.client.chat({
      model: options.modelId,
      messages,
      tools,
      options: options.options,
      format: options.format,
      keep_alive: options.keep_alive,
      stream: false,
    });

    return modelResultFrom(response);
  }

  /**
   * Stream incremental chat responses via Ollama.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns An async generator yielding normalized {@link ModelResult} chunks.
   */
  async stream(
    options: OllamaGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<OllamaModels>>> {
    const messages = ollamaMessagesFrom(options.messages);

    if (options.system) {
      messages.unshift({ role: "system", content: options.system });
    }

    const tools = options.tools ? ollamaToolsFrom(options.tools) : undefined;

    const stream = await this.client.chat({
      model: options.modelId,
      messages,
      tools,
      options: options.options,
      format: options.format,
      keep_alive: options.keep_alive,
      stream: true,
    });

    return (async function* () {
      for await (const chunk of stream) {
        yield modelResultFrom(chunk);
      }
    })();
  }
}

function assertValidHostUrl(
  host: string | undefined,
  hasApiKey: boolean,
): void {
  if (!hasApiKey || !host) {
    return;
  }

  try {
    const url = new URL(host);

    const isLocalhost = url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";

    if (url.protocol !== "https:" && !isLocalhost) {
      console.warn(
        "[SECURITY WARNING] Ollama API key is being sent over an unencrypted connection (HTTP). " +
          "This is a security risk. Please use HTTPS when connecting to remote Ollama instances with API keys.",
      );
    }
  } catch {
    // Invalid URL format - the Ollama client will handle this
  }
}

function resolveApiKey(options?: OllamaOptions): string | undefined {
  const apiKey = options?.apiKey?.trim() ||
    Deno.env.get("OLLAMA_API_KEY")?.trim();
  return apiKey || undefined;
}

function modelResultFrom(response: ChatResponse): ModelResult<OllamaModels> {
  const contents: (TextContent | ToolCallContent)[] = [];
  const toolCalls: ToolCallContent["toolCall"][] = [];

  if (response.message.content) {
    contents.push({ text: response.message.content });
  }

  if (response.message.tool_calls) {
    for (const toolCall of response.message.tool_calls) {
      const tc = {
        // Ollama doesn't provide an ID for tool calls, so we generate one.
        id: crypto.randomUUID(),
        name: toolCall.function.name,
        // deno-lint-ignore no-explicit-any
        props: toolCall.function.arguments as any,
      };

      contents.push({ toolCall: tc });
      toolCalls.push(tc);
    }
  }

  const message: ModelMessage = {
    role: "model",
    contents,
    toolCalls,
    thinking: response.message.thinking,
  };

  const usage = ollamaUsageFrom(response);
  return {
    modelId: response.model as OllamaModels,
    messages: [message],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Maps Ollama token counts to the normalized {@link ModelUsage}.
 *
 * Ollama only reports `prompt_eval_count` and `eval_count` on the final
 * (`done`) response, so streamed intermediate chunks carry no usage.
 */
export function ollamaUsageFrom(
  response: ChatResponse,
): ModelUsage | undefined {
  if (!response.done) {
    return undefined;
  }

  const usage: ModelUsage = {};
  if (typeof response.prompt_eval_count === "number") {
    usage.inputTokens = response.prompt_eval_count;
  }
  if (typeof response.eval_count === "number") {
    usage.outputTokens = response.eval_count;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }

  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return usage;
}

/**
 * Serializes a tool execution result into the single string Ollama's
 * `role: "tool"` message requires. Errors take precedence over output,
 * and non-string payloads are JSON-encoded.
 */
function toolOutputString(
  result: { output?: unknown; error?: unknown },
): string {
  const value = result.error ?? result.output;
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Converts Huuma {@link Tool}s into Ollama tool definitions. */
// deno-lint-ignore no-explicit-any
export function ollamaToolsFrom(tools: Tool<any>[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input.jsonSchema(),
    },
  }));
}

/**
 * Converts a file content part into an Ollama image entry.
 *
 * Ollama only takes base64 images on the message's `images` array: image
 * URLs throw (there is no URL source and adapters never fetch), and any
 * non-image media type throws.
 */
function ollamaImageFrom(file: FileContent["file"]): string {
  if (!file.mimeType.startsWith("image/")) {
    throw new RangeError(
      `Ollama adapter does not support file content of type "${file.mimeType}"`,
    );
  }

  const source = fileSourceFrom(file);
  if (source.kind === "url") {
    throw new RangeError(
      "Ollama adapter does not support images by URL; pass base64 data instead",
    );
  }
  return source.data;
}

/**
 * Converts shared messages into Ollama request messages.
 *
 * The `thinking` field is round-tripped so thinking-capable models can carry
 * reasoning state across tool-call iterations, and fully empty assistant
 * messages are skipped to avoid sending malformed payloads.
 */
export function ollamaMessagesFrom(messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const content = typeof message.contents === "string"
        ? message.contents
        : message.contents.map((c) => c.text).join("");

      result.push({ role: "system", content });
    } else if (message.role === "user") {
      if (typeof message.contents === "string") {
        result.push({ role: "user", content: message.contents });
        continue;
      }

      const textParts: string[] = [];
      const images: string[] = [];
      for (const c of message.contents) {
        if ("text" in c) {
          textParts.push(c.text);
        } else {
          images.push(ollamaImageFrom(c.file));
        }
      }

      const userMessage: OllamaMessage = {
        role: "user",
        content: textParts.join(""),
      };
      if (images.length > 0) {
        userMessage.images = images;
      }
      result.push(userMessage);
    } else if (message.role === "model") {
      const contentParts: string[] = [];
      const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];

      for (const c of message.contents) {
        if ("text" in c) {
          contentParts.push(c.text);
        } else if ("toolCall" in c) {
          toolCalls.push({
            function: {
              name: c.toolCall.name,
              arguments: c.toolCall.props || {},
            },
          });
        }
      }

      const content = contentParts.join("");

      // Skip fully empty assistant messages (no text, no tool calls, no
      // thinking). Mirrors Google's behavior of only emitting populated
      // Content entries and avoids sending malformed payloads to Ollama.
      if (!content && toolCalls.length === 0 && !message.thinking) {
        continue;
      }

      // Round-trip the `thinking` field so thinking-capable models
      // (deepseek-r1, qwen3, gpt-oss, ...) can carry reasoning state
      // across tool-call iterations. This is the Ollama analog to
      // Google's `thoughtSignature` round-tripping.
      result.push({
        role: "assistant",
        content,
        thinking: message.thinking,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else if (message.role === "tool") {
      // Ollama tool messages carry no images, so each tool result's files
      // ride their own synthetic user message after the tool messages —
      // wire-only, never part of shared history (ADR 0004). One message
      // per result keeps every image structurally tied to its call's
      // label; a shared flat `images` array could not express that.
      const fileMessages: OllamaMessage[] = [];
      for (const c of message.contents) {
        if ("toolResult" in c) {
          const { id, name, result: r, files } = c.toolResult;

          result.push({
            role: "tool",
            content: toolOutputString(r),
            tool_name: name,
          } as OllamaMessage);
          if (files?.length) {
            fileMessages.push({
              role: "user",
              content: toolFilesLabel(name, id),
              images: files.map((file) => ollamaImageFrom(file.file)),
            });
          }
        }
      }
      result.push(...fileMessages);
    }
  }

  return result;
}

/**
 * Convenience function to create an OllamaModel.
 *
 * @param options - The configuration options.
 * @returns An instance of OllamaModel.
 *
 * @example
 * ```typescript
 * // Using environment variable (recommended)
 * const model = ollama({ host: "https://api.ollama.com" });
 *
 * // Explicit API key (use with caution)
 * const model = ollama({
 *   host: "https://api.ollama.com",
 *   apiKey: process.env.OLLAMA_API_KEY
 * });
 * ```
 */
export function ollama(options?: OllamaOptions): OllamaModel {
  return new OllamaModel(options);
}
