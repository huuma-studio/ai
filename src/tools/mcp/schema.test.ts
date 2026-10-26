import { expect, test } from "vite-plus/test";
import type { JSONSchema, Schema } from "@huuma/validate";
import { PassthroughSchema } from "./schema.ts";

const SERVER_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
} as JSONSchema;

test("PassthroughSchema - jsonSchema returns the exact object", () => {
  const schema = new PassthroughSchema(SERVER_SCHEMA);
  expect(schema.jsonSchema()).toStrictEqual(SERVER_SCHEMA);
});

test("PassthroughSchema - validate passes values through", () => {
  const schema = new PassthroughSchema(SERVER_SCHEMA);
  const { value, errors } = schema.validate({ a: 1 });
  expect(value).toStrictEqual({ a: 1 });
  expect(errors).toBe(undefined);
});

test("PassthroughSchema - null and undefined coerce to {}", () => {
  const schema = new PassthroughSchema(SERVER_SCHEMA);
  expect(schema.validate(undefined).value).toStrictEqual({});
  expect(schema.validate(null).value).toStrictEqual({});
});

test("PassthroughSchema - assignable where a Schema is expected", () => {
  // Compile-time check: PassthroughSchema satisfies the Schema interface
  // Tool's input requires.
  const schema: Schema<Record<string, unknown>> = new PassthroughSchema(SERVER_SCHEMA);
  expect(schema.isRequired()).toBe(true);
});
