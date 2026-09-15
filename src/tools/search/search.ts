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
  /** Maximum duration of each search in milliseconds. Defaults to 30s. */
  timeout?: number;
}

/** Default maximum duration of a search. */
export const DEFAULT_SEARCH_TIMEOUT = 30_000;

/** Create a tool that searches the web.
 *
 * @param options Search engine, API key, and optional timeout.
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
      "Search for information on the internet using Perplexity, Brave Search, or Ollama. Provide a query string.",
    input: object({
      query: string(),
      count: number().optional(),
    }),
    timeout: options?.timeout ?? DEFAULT_SEARCH_TIMEOUT,
    fn: async ({ query, count }, { signal }) => {
      return await searchTool.search(query, { count, signal });
    },
  });
}
