import { object, string } from "@huuma/validate";
import { extract } from "@std/front-matter/yaml";
import { join } from "@std/path";
import { tool } from "@/tools/mod.ts";

const skillFrontmatterSchema = object({
  name: string().notEmpty(),
  description: string().notEmpty(),
  license: string().optional(),
  compatibility: string().optional(),
  metadata: object({}).optional(),
  "allowed-tools": string().optional(),
});

export type SkillFrontmatter = typeof skillFrontmatterSchema.infer;

export interface SkillInfo {
  folder: string;
  frontmatter: SkillFrontmatter;
  body: string;
}

export function skills({ path = "./skills" }: { path?: string } = {}) {
  let loadedSkills: SkillInfo[] | null = null;

  async function loadSkills(): Promise<SkillInfo[]> {
    if (loadedSkills) return loadedSkills;

    const skills: SkillInfo[] = [];
    const fullPath = join(Deno.cwd(), path);

    try {
      for await (const entry of Deno.readDir(fullPath)) {
        if (!entry.isDirectory) continue;

        const skillPath = join(fullPath, entry.name, "SKILL.md");

        try {
          const content = await Deno.readTextFile(skillPath);
          const { attrs, body } = extract(content);
          const validation = skillFrontmatterSchema.validate(attrs);

          if (validation.errors) {
            console.warn(
              `Invalid frontmatter in ${skillPath}:`,
              validation.errors,
            );
            continue;
          }

          skills.push({
            folder: entry.name,
            frontmatter: validation.value,
            body,
          });
        } catch {
          continue;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    loadedSkills = skills;
    return loadedSkills;
  }

  const listSkills = tool({
    name: "list_skills",
    description: "Lists available skills with their name and description",
    input: object({}),
    fn: async () => {
      const skills = await loadSkills();
      return skills.map(({ folder, frontmatter }) => ({
        folder,
        name: frontmatter.name,
        description: frontmatter.description,
      }));
    },
  });

  const retrieveSkill = tool({
    name: "retrieve_skill",
    description: "Retrieves full instructions for a specific skill by name",
    input: object({
      name: string().notEmpty(),
    }),
    fn: async ({ name }) => {
      const skills = await loadSkills();
      const skill = skills.find((s) => s.frontmatter.name === name);

      if (!skill) {
        throw new Error(`Skill "${name}" not found`);
      }

      return {
        folder: skill.folder,
        frontmatter: skill.frontmatter,
        body: skill.body,
      };
    },
  });

  return [listSkills, retrieveSkill] as const;
}
