import { object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";
import type { Agent } from "@/agent/mod.ts";
import type { Message, TextContent } from "@/mod.ts";

/** Options for configuring the subagent tool. */
export interface SubagentToolOptions<T extends string> {
  /** Tool name the parent model calls to delegate. */
  name: string;
  /** Description guiding the parent model on when/how to delegate. */
  description: string;
  /** The pre-configured sub-agent to delegate to. */
  agent: Agent<T>;
}

function finalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "model") continue;
    return message.contents
      .filter((content): content is TextContent => "text" in content)
      .map((content) => content.text)
      .join("\n");
  }
  return "";
}

/** Create a tool that delegates a task to a pre-configured sub-agent.
 *
 * The sub-agent runs its own orchestration loop (model, tools, system
 * prompt) and only its final assistant text is returned to the parent;
 * intermediate messages stay in the sub-agent. Each call starts fresh —
 * no parent history is shared — so the tool description should instruct
 * the parent model to send self-contained prompts.
 *
 * @example
 * ```typescript
 * import { agent } from "jsr:@huuma/ai/agent";
 * import { openai } from "jsr:@huuma/ai/models/openai";
 * import { cli, subagent } from "jsr:@huuma/ai/tools";
 *
 * const researcher = agent({
 *   model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
 *   modelId: "gpt-5.5",
 *   systemPrompt: "You research topics and answer concisely.",
 *   tools: [cli({ allowedCommands: ["deno"] })],
 * });
 *
 * const research = subagent({
 *   name: "research",
 *   description:
 *     "Delegate research tasks. Provide a self-contained prompt with all needed context.",
 *   agent: researcher,
 * });
 * ```
 *
 * @param options Configuration including the tool name, description, and sub-agent.
 * @returns A {@link Tool} that runs the sub-agent and returns its final assistant text.
 */
export function subagent<T extends string>(
  { name, description, agent }: SubagentToolOptions<T>,
  // deno-lint-ignore no-explicit-any
): Tool<any, string> {
  return new Tool({
    name,
    description,
    input: object({
      prompt: string(),
    }),
    fn: async ({ prompt }) => {
      const messages = await agent.run(prompt);
      return finalText(messages);
    },
  });
}
