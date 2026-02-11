import { object } from "@huuma/validate/object";
import { type Tool, tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate/string";
import { NodeHtmlMarkdown } from "node-html-markdown";

// deno-lint-ignore no-explicit-any
export function fetchWebsite(): Tool<any, string> {
  return tool({
    name: "fetch_website",
    description:
      "Fetch the content of a website. Returns the raw HTML content.",
    input: object({
      url: string(),
    }),
    fn: async ({ url }) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
          );
        }
        const text = await response.text();
        return NodeHtmlMarkdown.translate(text);
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Error fetching ${url}: ${error.message}`);
        }
        throw error;
      }
    },
  });
}
