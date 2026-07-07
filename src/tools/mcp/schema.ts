import type { JSONSchema, Schema } from "@huuma/validate";

/**
 * Pass-through `Schema` around a server's raw JSON Schema.
 *
 * `jsonSchema()` returns the server's schema verbatim and `validate`
 * accepts any value. Input validation is the server's job (spec SEP-1303);
 * conversion to local schemas is the ecosystem's documented dead end
 * (ADR 0002).
 */
export class PassthroughSchema implements Schema<Record<string, unknown>> {
  readonly infer!: Record<string, unknown>;
  #jsonSchema: JSONSchema;

  constructor(jsonSchema: JSONSchema) {
    this.#jsonSchema = jsonSchema;
  }

  validate(
    value: unknown,
  ): { value: Record<string, unknown>; errors: undefined } {
    // Tool calls without arguments arrive as null/undefined props; MCP
    // servers expect an (empty) arguments object.
    return {
      value: (value ?? {}) as Record<string, unknown>,
      errors: undefined,
    };
  }

  jsonSchema(): JSONSchema {
    return this.#jsonSchema;
  }

  isRequired(): boolean {
    return true;
  }
}
