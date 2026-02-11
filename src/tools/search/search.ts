import {
  number,
  type NumberSchema,
  object,
  type ObjectSchema,
  string,
  type StringSchema,
} from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";
import { type SearchEngine, SearchTool } from "./mod.ts";
import type { SearchResponse } from "./types.ts";

export function search(
  options?: { engine: SearchEngine; apiKey?: string },
): Tool<
  ObjectSchema<{
    query: StringSchema<string>;
    count: NumberSchema<number | undefined>;
  }>,
  SearchResponse
> {
  const searchTool = new SearchTool(
    options?.engine
      ? { engine: options.engine, apiKey: options.apiKey }
      : undefined,
  );
  return new Tool({
    name: "search",
    description:
      "Search for information on the internet using Perplexity or Brave Search. Provide a query string.",
    input: object({
      query: string(),
      count: number().optional(),
    }),
    fn: async ({ query, count }) => {
      return await searchTool.search(query, { count });
    },
  });
}
