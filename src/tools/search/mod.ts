import { BraveSearchProvider } from "./brave.ts";
import type { SearchOptions, SearchProvider, SearchResponse } from "./types.ts";

export type SearchEngine = "brave";

export class SearchTool {
  private provider: SearchProvider;

  constructor(engine?: SearchEngine) {
    if (engine === "brave") {
      this.provider = new BraveSearchProvider();
    } else {
      // Auto-detect based on env vars
      if (Deno.env.get("BRAVE_API_KEY")) {
        this.provider = new BraveSearchProvider();
      } else {
        throw new Error(
          "No search provider configured. Please set BRAVE_API_KEY or (GOOGLE_API_KEY and GOOGLE_CX).",
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
