import { assertEquals } from "@std/assert";
import { anthropicMessagesFrom } from "./mod.ts";
import type { Message } from "@/mod.ts";

Deno.test("anthropicMessagesFrom - user message string", () => {
  const messages: Message[] = [
    { role: "user", contents: "Hello world" }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { role: "user", content: "Hello world" }
  ]);
});

Deno.test("anthropicMessagesFrom - user message array", () => {
  const messages: Message[] = [
    { role: "user", contents: [{ text: "Hello" }, { text: "World" }] }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { role: "user", content: [{ type: "text", text: "Hello" }, { type: "text", text: "World" }] }
  ]);
});

Deno.test("anthropicMessagesFrom - model message text", () => {
  const messages: Message[] = [
    { role: "model", contents: [{ text: "Response" }], toolCalls: [] }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { role: "assistant", content: [{ type: "text", text: "Response" }] }
  ]);
});

Deno.test("anthropicMessagesFrom - model message tool call", () => {
  const messages: Message[] = [
    { 
      role: "model", 
      // deno-lint-ignore no-explicit-any
      contents: [{ toolCall: { id: "call_1", name: "weather", props: { city: "London" } as any } }], 
      // deno-lint-ignore no-explicit-any
      toolCalls: [{ id: "call_1", name: "weather", props: { city: "London" } as any }] 
    }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { 
      role: "assistant", 
      content: [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "London" } }] 
    }
  ]);
});

Deno.test("anthropicMessagesFrom - tool message result output", () => {
  const messages: Message[] = [
    { 
      role: "tool", 
      contents: [{ toolResult: { id: "call_1", name: "weather", result: { output: "Sunny" } } }] 
    }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { 
      role: "user", 
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny" }] 
    }
  ]);
});

Deno.test("anthropicMessagesFrom - tool message result object output", () => {
  const messages: Message[] = [
    { 
      role: "tool", 
      contents: [{ toolResult: { id: "call_1", name: "weather", result: { output: { temp: 20 } } } }] 
    }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { 
      role: "user", 
      content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"temp":20}' }] 
    }
  ]);
});

Deno.test("anthropicMessagesFrom - tool message result error", () => {
  const messages: Message[] = [
    { 
      role: "tool", 
      contents: [{ toolResult: { id: "call_1", name: "weather", result: { error: "API Error" } } }] 
    }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { 
      role: "user", 
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "API Error", is_error: true }] 
    }
  ]);
});

Deno.test("anthropicMessagesFrom - system message skipped", () => {
  const messages: Message[] = [
    { role: "system", contents: "You are a bot" },
    { role: "user", contents: "Hi" }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { role: "user", content: "Hi" }
  ]);
});

Deno.test("anthropicMessagesFrom - mixed sequence", () => {
  const messages: Message[] = [
    { role: "user", contents: "What's the weather?" },
    // deno-lint-ignore no-explicit-any
    { role: "model", contents: [{ toolCall: { id: "c1", name: "w", props: {} as any } }], toolCalls: [] },
    { role: "tool", contents: [{ toolResult: { id: "c1", name: "w", result: { output: "Rain" } } }] }
  ];
  const result = anthropicMessagesFrom(messages);
  assertEquals(result, [
    { role: "user", content: "What's the weather?" },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "w", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Rain" }] }
  ]);
});
