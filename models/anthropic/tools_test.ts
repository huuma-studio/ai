import { assertEquals } from "@std/assert";
import { object, string } from "@huuma/validate";
import { tool } from "@/tools/mod.ts";
import { anthropicToolsFrom } from "./mod.ts";

Deno.test("anthropicToolsFrom", () => {
  const myTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({
      query: string(),
    }),
    fn: () => {},
  });

  const anthropicTools = anthropicToolsFrom([myTool]);

  assertEquals(anthropicTools.length, 1);
  const t = anthropicTools[0];
  assertEquals(t.name, "test_tool");
  assertEquals(t.description, "A test tool");
  
  // deno-lint-ignore no-explicit-any
  const schema = t.input_schema as any;
  
  assertEquals(schema.type, "object");
  if (schema.properties) {
      assertEquals(schema.properties.query.type, "string");
  }
});
