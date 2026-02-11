import type { SearchOptions, SearchProvider, SearchResponse } from "./types.ts";

interface PerplexityResult {
  title: string;
  url: string;
  snippet: string;
}

interface PerplexityApiResponse {
  results: PerplexityResult[];
}

export class PerplexitySearchProvider implements SearchProvider {
  #apiKey?: string;

  constructor(apiKey?: string) {
    this.#apiKey = apiKey;
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    const apiKey = this.#apiKey ?? Deno.env.get("PERPLEXITY_API_KEY");

    if (!apiKey) {
      throw new Error("Perplexity API Key is required");
    }

    const response = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query,
        max_results: options?.count,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Perplexity Search failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as PerplexityApiResponse;

    const results = (data.results || []).map((result) => ({
      title: result.title,
      link: result.url,
      snippet: result.snippet,
    }));

    return { results };
  }
}
