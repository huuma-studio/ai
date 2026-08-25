import { BraveSearchProvider } from "./brave.ts";
import { OllamaSearchProvider } from "./ollama.ts";
import { PerplexitySearchProvider } from "./perplexity.ts";
import type { SearchOptions, SearchProvider, SearchResponse } from "./types.ts";

export type SearchEngine = "brave" | "perplexity" | "ollama";

export class SearchTool {
  private provider: SearchProvider;

  constructor(options?: { engine: SearchEngine; apiKey?: string }) {
    if (options?.engine === "brave") {
      this.provider = new BraveSearchProvider(options.apiKey);
    } else if (options?.engine === "perplexity") {
      this.provider = new PerplexitySearchProvider(options.apiKey);
    } else if (options?.engine === "ollama") {
      this.provider = new OllamaSearchProvider(options.apiKey);
    } else {
      // Auto-detect based on env vars
      if (Deno.env.get("PERPLEXITY_API_KEY")) {
        this.provider = new PerplexitySearchProvider();
      } else if (Deno.env.get("BRAVE_API_KEY")) {
        this.provider = new BraveSearchProvider();
      } else if (Deno.env.get("OLLAMA_SEARCH_API_KEY")) {
        this.provider = new OllamaSearchProvider();
      } else {
        throw new Error(
          "No search provider configured. Please set PERPLEXITY_API_KEY, BRAVE_API_KEY, or OLLAMA_SEARCH_API_KEY.",
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
