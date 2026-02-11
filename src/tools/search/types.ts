export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface SearchOptions {
  apiKey?: string;
  count?: number;
}

export interface SearchProvider {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
