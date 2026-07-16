import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { callTool, tools } from "@/tools/mod.ts";
import { skills } from "@/tools/skills/skills.ts";
import { agent } from "@/agent/mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
} from "@/agent/mod.ts";

/** Absolute path to the fixture skills tree (also exercises finding 4). */
const FIXTURES = new URL("./testdata/skills", import.meta.url).pathname;

type ListResult = { name: string; description: string }[];
type RetrieveResult = {
  name: string;
  description: string;
  path: string;
  metadata: unknown;
  "allowed-tools": string | string[] | undefined;
  instructions: string;
};

/** Collects warnings into an array and returns the callback + buffer. */
function collector() {
  const warnings: string[] = [];
  const onWarning = (message: string) => warnings.push(message);
  return { warnings, onWarning };
}

Deno.test("skills - lists valid skills only, sorted, { name, description }", async () => {
  const { onWarning } = collector();
  const [list] = skills({ path: FIXTURES, onWarning });

  const result = await list.call({}) as ListResult;

  assertEquals(result, [
    {
      name: "commit-style",
      description: "Draft a conventional-commit message from staged changes.",
    },
    {
      name: "duplicate-skill",
      description: "First declaration of a duplicated skill name.",
    },
    {
      name: "web-research",
      description: "Research a topic on the web and summarize findings with sources.",
    },
  ]);
});

Deno.test("skills - warns once per broken fixture, never for non-skills", async () => {
  const { warnings, onWarning } = collector();
  const [list] = skills({ path: FIXTURES, onWarning });

  await list.call({});

  // Exactly four diagnostics: broken-yaml, no-frontmatter, missing-desc,
  // and the duplicate name. `not-a-skill` (no SKILL.md) and the stray
  // `README.md` are skipped silently.
  assertEquals(warnings.length, 4);

  assertStringIncludes(
    warnings.find((w) => w.includes("broken-yaml"))!,
    "broken-yaml/SKILL.md",
  );
  assertStringIncludes(
    warnings.find((w) => w.includes("no-frontmatter"))!,
    "no-frontmatter/SKILL.md",
  );
  assertStringIncludes(
    warnings.find((w) => w.includes("missing-desc"))!,
    "missing-desc/SKILL.md",
  );
  assertStringIncludes(
    warnings.find((w) => w.includes("dupe-b"))!,
    "dupe-b/SKILL.md",
  );

  // Non-skills must not produce diagnostics.
  assertEquals(warnings.some((w) => w.includes("not-a-skill")), false);
  assertEquals(warnings.some((w) => w.includes("README.md")), false);
});

Deno.test("skills - retrieve by name returns instructions, metadata, list allowed-tools, absolute path", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  const skill = await retrieve.call({ name: "web-research" }) as RetrieveResult;

  assertEquals(skill.name, "web-research");
  assertEquals(skill.description, "Research a topic on the web and summarize findings with sources.");
  // metadata preserved verbatim (finding 2 regression).
  assertEquals(skill.metadata, { author: "huuma", tags: ["research", "web"] });
  // list-form allowed-tools accepted (finding 3 regression).
  assertEquals(skill["allowed-tools"], ["fetchWebsite", "search"]);
  // absolute skill folder path (finding 13).
  assertEquals(skill.path, join(FIXTURES, "web-research"));
  assertStringIncludes(skill.instructions, "# Web research");
  assertStringIncludes(skill.instructions, "references/sources.md");
});

Deno.test("skills - retrieve by folder name resolves the same skill", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  // dupe-a's frontmatter name is "duplicate-skill"; its folder is "dupe-a".
  const byFolder = await retrieve.call({ name: "dupe-a" }) as RetrieveResult;
  const byName = await retrieve.call({ name: "duplicate-skill" }) as RetrieveResult;

  assertEquals(byFolder.path, join(FIXTURES, "dupe-a"));
  assertEquals(byName.path, join(FIXTURES, "dupe-a"));
  assertEquals(byFolder.instructions, byName.instructions);
});

Deno.test("skills - string-form allowed-tools parses", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  const skill = await retrieve.call({ name: "commit-style" }) as RetrieveResult;
  assertEquals(skill["allowed-tools"], "cli");
});

Deno.test("skills - unknown name throws listing available skills", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  await assertRejects(
    () => retrieve.call({ name: "nope" }),
    Error,
    'Skill "nope" not found. Available skills: commit-style, duplicate-skill, web-research',
  );
});

Deno.test("skills - duplicate name resolves to the sorted-first folder (dupe-a)", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  const skill = await retrieve.call({ name: "duplicate-skill" }) as RetrieveResult;
  assertEquals(skill.path, join(FIXTURES, "dupe-a"));
});

Deno.test("skills - missing skills directory yields an empty list with no warning", async () => {
  const { warnings, onWarning } = collector();
  const missing = new URL("./testdata/does-not-exist", import.meta.url).pathname;
  const [list] = skills({ path: missing, onWarning });

  const result = await list.call({}) as ListResult;
  assertEquals(result, []);
  assertEquals(warnings, []);
});

Deno.test("skills - absolute path option works", async () => {
  const { onWarning } = collector();
  // FIXTURES is already absolute; asserting the factory accepts it directly.
  assert(FIXTURES.startsWith("/"), "fixture path must be absolute");
  const [list] = skills({ path: FIXTURES, onWarning });

  const result = await list.call({}) as ListResult;
  assertEquals(result.length, 3);
});

Deno.test("skills - concurrent first calls share one scan", async () => {
  const { warnings, onWarning } = collector();
  const [list, retrieve] = skills({ path: FIXTURES, onWarning });

  // Fire both tools without awaiting between them. A single scan emits
  // exactly one duplicate-name warning; two scans would emit two.
  await Promise.all([
    list.call({}),
    retrieve.call({ name: "web-research" }),
  ]);

  const dupes = warnings.filter((w) => w.includes("Duplicate skill name"));
  assertEquals(dupes.length, 1);
});

Deno.test("skills - a rejected scan retries on the next call", async (t) => {
  const tempDir = await Deno.makeTempDir();
  const target = join(tempDir, "skills");
  // Start as a file: readDir rejects with NotADirectory.
  await Deno.writeTextFile(target, "not a directory");

  const { onWarning } = collector();
  const [list] = skills({ path: target, onWarning });

  await assertRejects(() => list.call({}), Deno.errors.NotADirectory);

  // Replace the file with a directory containing a valid skill folder.
  await Deno.remove(target);
  await Deno.mkdir(target);
  await Deno.mkdir(join(target, "temp-skill"));
  await Deno.writeTextFile(
    join(target, "temp-skill", "SKILL.md"),
    [
      "---",
      "name: temp-skill",
      "description: A skill created after the first scan failed.",
      "---",
      "# Temp",
    ].join("\n"),
  );

  const result = await list.call({}) as ListResult;
  assertEquals(result, [{
    name: "temp-skill",
    description: "A skill created after the first scan failed.",
  }]);

  await t.step({ name: "cleanup", fn: () => Deno.remove(tempDir, { recursive: true }) });
});

Deno.test({
  name:
    "skills - a symlink whose target cannot be traversed warns instead of vanishing",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Put the real skill under a dir that will be locked, outside the scan
    // root, so only the symlink path hits `Deno.stat` and the locked parent
    // makes that stat throw `PermissionDenied`.
    const outer = await Deno.makeTempDir();
    const scanRoot = await Deno.makeTempDir();
    const real = join(outer, "real");
    await Deno.mkdir(join(real, "skill"), { recursive: true });
    await Deno.writeTextFile(
      join(real, "skill", "SKILL.md"),
      ["---", "name: locked", "description: Behind a permission-denied symlink.", "---", ""].join("\n"),
    );
    await Deno.symlink(real, join(scanRoot, "link"));
    await Deno.chmod(outer, 0o000);

    try {
      // Bail out on hosts where the perm trick doesn't deny (e.g. root),
      // so the test never false-fails there.
      let denied = false;
      try {
        await Deno.stat(join(scanRoot, "link"));
      } catch {
        denied = true;
      }
      if (!denied) return;

      const { warnings, onWarning } = collector();
      const [list] = skills({ path: scanRoot, onWarning });

      const result = await list.call({}) as ListResult;
      assertEquals(result, []);
      assert(
        warnings.some((w) =>
          w.includes("link") && w.includes("Failed to inspect")),
        `expected a symlink-inspection warning, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      await Deno.chmod(outer, 0o700);
      await Deno.remove(outer, { recursive: true });
      await Deno.remove(scanRoot, { recursive: true });
    }
  },
});

// --- Agent end-to-end -------------------------------------------------------

type ScriptedResponse =
  | Message[]
  | { messages: Message[]; usage?: unknown };

class StubModel implements BaseModel<string> {
  #responses: ScriptedResponse[];
  constructor(responses: ScriptedResponse[]) {
    this.#responses = responses;
  }
  generate(): Promise<ModelResult<string>> {
    const response = this.#responses.shift();
    if (!response) return Promise.reject(new Error("No scripted response left"));
    const { messages, usage } = Array.isArray(response)
      ? { messages: response, usage: undefined }
      : response;
    return Promise.resolve({ modelId: "stub", messages, ...(usage ? { usage } : {}) });
  }
  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

function modelMessage(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

function modelToolCall(name: string, props: Record<string, unknown>): Message {
  const toolCall = {
    id: `call-${name}`,
    name,
    props: props as unknown as JSONSchema,
  };
  return {
    role: "model",
    contents: [{ toolCall }],
    toolCalls: [toolCall],
  };
}

Deno.test("skills - agent end-to-end through Agent.run", async () => {
  const { onWarning } = collector();
  const [listSkills, retrieveSkill] = skills({ path: FIXTURES, onWarning });

  const model = new StubModel([
    [modelToolCall("list_skills", {})],
    [modelToolCall("retrieve_skill", { name: "commit-style" })],
    [modelMessage("Done.")],
  ]);

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "You use skills.",
    tools: [listSkills, retrieveSkill],
  });

  const messages = await assistant.run("Use the commit-style skill.");

  // Two tool turns then the final model message.
  const last = messages.at(-1)!;
  assertEquals(last.role, "model");
  const finalText = last.contents[0] as { text: string };
  assertEquals(finalText.text, "Done.");

  const toolMessages = messages.filter((m) => m.role === "tool");
  assertEquals(toolMessages.length, 2);

  // The retrieve result reaches the model via callTool.
  const afterRetrieve = await callTool(tools([listSkills, retrieveSkill]))([
    modelToolCall("retrieve_skill", { name: "commit-style" }),
  ]);
  assertEquals(afterRetrieve.at(-1)!.role, "tool");
});