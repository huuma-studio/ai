import { BraveSearchProvider } from "./brave.ts";
import { PerplexitySearchProvider } from "./perplexity.ts";
import type { SearchOptions, SearchProvider, SearchResponse } from "./types.ts";

export type SearchEngine = "brave" | "perplexity";

export class SearchTool {
  private provider: SearchProvider;

  constructor(options?: { engine: SearchEngine; apiKey?: string }) {
    if (options?.engine === "brave") {
      this.provider = new BraveSearchProvider(options.apiKey);
    } else if (options?.engine === "perplexity") {
      this.provider = new PerplexitySearchProvider(options.apiKey);
    } else {
      // Auto-detect based on env vars
      if (Deno.env.get("PERPLEXITY_API_KEY")) {
        this.provider = new PerplexitySearchProvider();
      } else if (Deno.env.get("BRAVE_API_KEY")) {
        this.provider = new BraveSearchProvider();
      } else {
        throw new Error(
          "No search provider configured. Please set PERPLEXITY_API_KEY or BRAVE_API_KEY.",
        );
      }
    }
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    return await this.provider.search(query, options);
  }
}
