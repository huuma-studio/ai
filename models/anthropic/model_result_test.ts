import { assertEquals } from "@std/assert";
import type { Anthropic } from "@anthropic-ai/sdk";
import { modelResultFrom } from "./mod.ts";

Deno.test("modelResultFrom - text only", () => {
  const mockResponse: Anthropic.Message = {
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [
      { type: "text", text: "Hello there!", citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
  };

  const result = modelResultFrom(mockResponse);

  assertEquals(result.modelId, "claude-sonnet-4-5-20250929");
  assertEquals(result.messages.length, 1);
  const message = result.messages[0];
  assertEquals(message.role, "model");
  assertEquals(message.contents.length, 1);
  assertEquals(message.contents[0], { text: "Hello there!" });
  if ("toolCalls" in message) {
    assertEquals(message.toolCalls.length, 0);
  }
});

Deno.test("modelResultFrom - text and tool use", () => {
  const mockResponse: Anthropic.Message = {
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [
      { type: "text", text: "I will check the weather.", citations: null },
      {
        type: "tool_use",
        id: "tool_1",
        name: "get_weather",
        input: { city: "London" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 15,
      output_tokens: 30,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
  };

  const result = modelResultFrom(mockResponse);

  assertEquals(result.modelId, "claude-sonnet-4-5-20250929");
  const message = result.messages[0];

  if (message.role !== "model") throw new Error("Expected model role");

  assertEquals(message.contents.length, 2);
  assertEquals(message.contents[0], { text: "I will check the weather." });

  const toolContent = message.contents[1];
  if (!("toolCall" in toolContent)) {
    throw new Error("Expected toolCall content");
  }

  assertEquals(toolContent.toolCall, {
    id: "tool_1",
    name: "get_weather",
    // deno-lint-ignore no-explicit-any
    props: { city: "London" } as any,
  });

  assertEquals(message.toolCalls.length, 1);
  assertEquals(message.toolCalls[0], {
    id: "tool_1",
    name: "get_weather",
    // deno-lint-ignore no-explicit-any
    props: { city: "London" } as any,
  });
});
