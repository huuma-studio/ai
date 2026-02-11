
import type { SearchOptions, SearchProvider, SearchResponse } from "./types.ts";

export class BraveSearchProvider implements SearchProvider {
  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const apiKey = options?.apiKey ?? Deno.env.get("BRAVE_API_KEY");

    if (!apiKey) {
      throw new Error("Brave API Key is required");
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    if (options?.count) {
      url.searchParams.set("count", options.count.toString());
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave Search failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // deno-lint-ignore no-explicit-any
    const results = (data.web?.results || []).map((item: any) => ({
      title: item.title,
      link: item.url,
      snippet: item.description,
    }));

    return { results };
  }
}
