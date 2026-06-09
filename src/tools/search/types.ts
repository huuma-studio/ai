/** A single web search result. */
export interface SearchResult {
  /** Result title. */
  title: string;
  /** Result URL. */
  link: string;
  /** Short result summary. */
  snippet: string;
}

/** Search response returned by providers. */
export interface SearchResponse {
  /** Search results. */
  results: SearchResult[];
}

/** Options for web search providers. */
export interface SearchOptions {
  /** Maximum number of results to return. */
  count?: number;
}

/** Interface implemented by search providers. */
export interface SearchProvider {
  /** Search for a query. */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
