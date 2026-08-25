import type { SearchOptions, SearchProvider, SearchResponse } from "./types.ts";

interface OllamaSearchResult {
  title: string;
  url: string;
  content: string;
}

interface OllamaSearchApiResponse {
  results: OllamaSearchResult[];
}

export class OllamaSearchProvider implements SearchProvider {
  #apiKey?: string;

  constructor(apiKey?: string) {
    this.#apiKey = apiKey;
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    const apiKey = this.#apiKey ??
      Deno.env.get("OLLAMA_SEARCH_API_KEY") ??
      Deno.env.get("OLLAMA_API_KEY");

    if (!apiKey) {
      throw new Error("Ollama API Key is required");
    }

    const body: { query: string; max_results?: number } = { query };
    if (options?.count) {
      body.max_results = options.count;
    }

    const response = await fetch("https://ollama.com/api/web_search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama Search failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as OllamaSearchApiResponse;

    const results = (data.results || []).map((result) => ({
      title: result.title,
      link: result.url,
      snippet: result.content,
    }));

    return { results };
  }
}