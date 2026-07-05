import { assertEquals } from "@std/assert";
import type { JSONSchema, Schema } from "@huuma/validate";
import { PassthroughSchema } from "@/tools/mcp/schema.ts";

const SERVER_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
} as JSONSchema;

Deno.test("PassthroughSchema - jsonSchema returns the exact object", () => {
  const schema = new PassthroughSchema(SERVER_SCHEMA);
  assertEquals(schema.jsonSchema(), SERVER_SCHEMA);
});

Deno.test("PassthroughSchema - validate passes values through", () => {
  const schema = new PassthroughSchema(SERVER_SCHEMA);
  const { value, errors } = schema.validate({ a: 1 });
  assertEquals(value, { a: 1 });
  assertEquals(errors, undefined);
});

Deno.test("PassthroughSchema - null and undefined coerce to {}", () => {
  const schema = new PassthroughSchema(SERVER_SCHEMA);
  assertEquals(schema.validate(undefined).value, {});
  assertEquals(schema.validate(null).value, {});
});

Deno.test("PassthroughSchema - assignable where a Schema is expected", () => {
  // Compile-time check: PassthroughSchema satisfies the Schema interface
  // Tool's input requires.
  const schema: Schema<Record<string, unknown>> = new PassthroughSchema(
    SERVER_SCHEMA,
  );
  assertEquals(schema.isRequired(), true);
});
