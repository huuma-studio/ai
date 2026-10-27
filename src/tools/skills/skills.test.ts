import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { callTool, tools } from "../mod.ts";
import { skills } from "./skills.ts";
import { agent } from "../../agent/mod.ts";
import type { BaseModel, JSONSchema, Message, ModelResult } from "../../agent/mod.ts";

/** Absolute path to the fixture skills tree (also exercises finding 4). */
const FIXTURES = fileURLToPath(new URL("./testdata/skills", import.meta.url));

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

test("skills - lists valid skills only, sorted, { name, description }", async () => {
  const { onWarning } = collector();
  const [list] = skills({ path: FIXTURES, onWarning });

  const result = (await list.call({})) as ListResult;

  expect(result).toStrictEqual([
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

test("skills - warns once per broken fixture, never for non-skills", async () => {
  const { warnings, onWarning } = collector();
  const [list] = skills({ path: FIXTURES, onWarning });

  await list.call({});

  // Exactly four diagnostics: broken-yaml, no-frontmatter, missing-desc,
  // and the duplicate name. `not-a-skill` (no SKILL.md) and the stray
  // `README.md` are skipped silently.
  expect(warnings.length).toStrictEqual(4);

  expect(warnings.find((w) => w.includes("broken-yaml"))!).toContain("broken-yaml/SKILL.md");
  expect(warnings.find((w) => w.includes("no-frontmatter"))!).toContain("no-frontmatter/SKILL.md");
  expect(warnings.find((w) => w.includes("missing-desc"))!).toContain("missing-desc/SKILL.md");
  expect(warnings.find((w) => w.includes("dupe-b"))!).toContain("dupe-b/SKILL.md");

  // Non-skills must not produce diagnostics.
  expect(warnings.some((w) => w.includes("not-a-skill"))).toBe(false);
  expect(warnings.some((w) => w.includes("README.md"))).toBe(false);
});

test("skills - retrieve by name returns instructions, metadata, list allowed-tools, absolute path", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  const skill = (await retrieve.call({ name: "web-research" })) as RetrieveResult;

  expect(skill.name).toStrictEqual("web-research");
  expect(skill.description).toStrictEqual(
    "Research a topic on the web and summarize findings with sources.",
  );
  // metadata preserved verbatim (finding 2 regression).
  expect(skill.metadata).toStrictEqual({ author: "huuma", tags: ["research", "web"] });
  // list-form allowed-tools accepted (finding 3 regression).
  expect(skill["allowed-tools"]).toStrictEqual(["fetchWebsite", "search"]);
  // absolute skill folder path (finding 13).
  expect(skill.path).toStrictEqual(join(FIXTURES, "web-research"));
  expect(skill.instructions).toContain("# Web research");
  expect(skill.instructions).toContain("references/sources.md");
});

test("skills - retrieve by folder name resolves the same skill", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  // dupe-a's frontmatter name is "duplicate-skill"; its folder is "dupe-a".
  const byFolder = (await retrieve.call({ name: "dupe-a" })) as RetrieveResult;
  const byName = (await retrieve.call({ name: "duplicate-skill" })) as RetrieveResult;

  expect(byFolder.path).toStrictEqual(join(FIXTURES, "dupe-a"));
  expect(byName.path).toStrictEqual(join(FIXTURES, "dupe-a"));
  expect(byFolder.instructions).toStrictEqual(byName.instructions);
});

test("skills - string-form allowed-tools parses", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  const skill = (await retrieve.call({ name: "commit-style" })) as RetrieveResult;
  expect(skill["allowed-tools"]).toStrictEqual("cli");
});

test("skills - unknown name throws listing available skills", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  await expect(retrieve.call({ name: "nope" })).rejects.toThrow(
    'Skill "nope" not found. Available skills: commit-style, duplicate-skill, web-research',
  );
});

test("skills - duplicate name resolves to the sorted-first folder (dupe-a)", async () => {
  const { onWarning } = collector();
  const [, retrieve] = skills({ path: FIXTURES, onWarning });

  const skill = (await retrieve.call({ name: "duplicate-skill" })) as RetrieveResult;
  expect(skill.path).toStrictEqual(join(FIXTURES, "dupe-a"));
});

test("skills - missing skills directory yields an empty list with no warning", async () => {
  const { warnings, onWarning } = collector();
  const missing = fileURLToPath(new URL("./testdata/does-not-exist", import.meta.url));
  const [list] = skills({ path: missing, onWarning });

  const result = (await list.call({})) as ListResult;
  expect(result).toStrictEqual([]);
  expect(warnings).toStrictEqual([]);
});

test("skills - absolute path option works", async () => {
  const { onWarning } = collector();
  // FIXTURES is already absolute; asserting the factory accepts it directly.
  // fixture path must be absolute
  expect(FIXTURES.startsWith("/")).toBe(true);
  const [list] = skills({ path: FIXTURES, onWarning });

  const result = (await list.call({})) as ListResult;
  expect(result.length).toStrictEqual(3);
});

test("skills - concurrent first calls share one scan", async () => {
  const { warnings, onWarning } = collector();
  const [list, retrieve] = skills({ path: FIXTURES, onWarning });

  // Fire both tools without awaiting between them. A single scan emits
  // exactly one duplicate-name warning; two scans would emit two.
  await Promise.all([list.call({}), retrieve.call({ name: "web-research" })]);

  const dupes = warnings.filter((w) => w.includes("Duplicate skill name"));
  expect(dupes.length).toStrictEqual(1);
});

test("skills - a rejected scan retries on the next call", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  try {
    const target = join(tempDir, "skills");
    // Start as a file: readdir rejects with ENOTDIR.
    await writeFile(target, "not a directory");

    const { onWarning } = collector();
    const [list] = skills({ path: target, onWarning });

    await expect(list.call({})).rejects.toMatchObject({ code: "ENOTDIR" });

    // Replace the file with a directory containing a valid skill folder.
    await rm(target);
    await mkdir(target);
    await mkdir(join(target, "temp-skill"));
    await writeFile(
      join(target, "temp-skill", "SKILL.md"),
      [
        "---",
        "name: temp-skill",
        "description: A skill created after the first scan failed.",
        "---",
        "# Temp",
      ].join("\n"),
    );

    const result = (await list.call({})) as ListResult;
    expect(result).toStrictEqual([
      {
        name: "temp-skill",
        description: "A skill created after the first scan failed.",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "skills - a symlink whose target cannot be traversed warns instead of vanishing",
  async () => {
    // Put the real skill under a dir that will be locked, outside the scan
    // root, so only the symlink path hits `stat` and the locked parent
    // makes that stat throw `EACCES`.
    const outer = await mkdtemp(join(tmpdir(), "huuma-ai-"));
    const scanRoot = await mkdtemp(join(tmpdir(), "huuma-ai-"));
    const real = join(outer, "real");
    await mkdir(join(real, "skill"), { recursive: true });
    await writeFile(
      join(real, "skill", "SKILL.md"),
      ["---", "name: locked", "description: Behind a permission-denied symlink.", "---", ""].join(
        "\n",
      ),
    );
    await symlink(real, join(scanRoot, "link"));
    await chmod(outer, 0o000);

    try {
      // Bail out on hosts where the perm trick doesn't deny (e.g. root),
      // so the test never false-fails there.
      let denied = false;
      try {
        await stat(join(scanRoot, "link"));
      } catch {
        denied = true;
      }
      if (!denied) return;

      const { warnings, onWarning } = collector();
      const [list] = skills({ path: scanRoot, onWarning });

      const result = (await list.call({})) as ListResult;
      expect(result).toStrictEqual([]);
      expect(
        warnings.some((w) => w.includes("link") && w.includes("Failed to inspect")),
        `expected a symlink-inspection warning, got: ${JSON.stringify(warnings)}`,
      ).toBe(true);
    } finally {
      await chmod(outer, 0o700);
      await rm(outer, { recursive: true, force: true });
      await rm(scanRoot, { recursive: true, force: true });
    }
  },
);

// --- Agent end-to-end -------------------------------------------------------

type ScriptedResponse = Message[] | { messages: Message[]; usage?: unknown };

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

test("skills - agent end-to-end through Agent.run", async () => {
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
  expect(last.role).toStrictEqual("model");
  const finalText = last.contents[0] as { text: string };
  expect(finalText.text).toStrictEqual("Done.");

  const toolMessages = messages.filter((m) => m.role === "tool");
  expect(toolMessages.length).toStrictEqual(2);

  // The retrieve result reaches the model via callTool.
  const afterRetrieve = await callTool(tools([listSkills, retrieveSkill]))([
    modelToolCall("retrieve_skill", { name: "commit-style" }),
  ]);
  expect(afterRetrieve.at(-1)!.role).toStrictEqual("tool");
});
