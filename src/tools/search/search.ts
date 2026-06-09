import { number, object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";
import { type SearchEngine, SearchTool } from "./mod.ts";
import type { SearchResponse } from "./types.ts";

/** Options for configuring the web-search tool. */
export interface SearchToolOptions {
  /** Search provider to use. */
  engine: SearchEngine;
  /** Provider API key. */
  apiKey?: string;
}

/** Create a tool that searches the web.
 *
 * @param options Search engine and optional API key.
 * @returns A {@link Tool} that queries the web and returns a {@link SearchResponse}.
 */
export function search(
  options?: SearchToolOptions,
  // deno-lint-ignore no-explicit-any
): Tool<any, SearchResponse> {
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
