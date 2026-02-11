import { number, object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";
import { type SearchEngine, SearchTool } from "./mod.ts";

// deno-lint-ignore no-explicit-any
export function search(engine?: SearchEngine): Tool<any, any> {
  const searchTool = new SearchTool(engine);
  return new Tool({
    name: "search",
    description:
      "Search for information on the internet using Google or Brave Search. Provide a query string.",
    input: object({
      query: string(),
      count: number().optional(),
    }),
    fn: async ({ query, count }) => {
      return await searchTool.search(query, { count });
    },
  });
}
