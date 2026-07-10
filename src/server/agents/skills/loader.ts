import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { convertJsonSchemaToZod } from 'zod-from-json-schema';
import { SkillFrontmatterSchema } from './schema';
import type { SkillTemplate } from '../types';
import { isRetiredBuiltinSkill } from './builtin-manifest';

export interface LoadResult {
  skills: SkillTemplate[];
  degraded: Array<{ skillId: string; errors: string[] }>;
}

export async function loadSkillsFromDir(dir: string): Promise<LoadResult> {
  const skills: SkillTemplate[] = [];
  const degraded: Array<{ skillId: string; errors: string[] }> = [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return { skills, degraded };
  }

  for (const entry of entries) {
    if (extname(entry) !== '.md') continue;
    const path = join(dir, entry);
    const filenameId = basename(entry, '.md');
    if (isRetiredBuiltinSkill(filenameId)) continue;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      degraded.push({ skillId: filenameId, errors: [`Could not read file: ${(e as Error).message}`] });
      continue;
    }

    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(raw);
    } catch (e) {
      degraded.push({ skillId: filenameId, errors: [`Frontmatter parse error: ${(e as Error).message}`] });
      continue;
    }

    const frontmatter = SkillFrontmatterSchema.safeParse(parsed.data);
    if (!frontmatter.success) {
      degraded.push({ skillId: filenameId, errors: frontmatter.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
      continue;
    }

    if (frontmatter.data.id !== filenameId) {
      degraded.push({
        skillId: filenameId,
        errors: [`id "${frontmatter.data.id}" does not match filename "${filenameId}"`],
      });
      continue;
    }

    let outputSchema: z.ZodSchema | undefined;
    if (frontmatter.data.outputSchema) {
      try {
        const json = JSON.parse(frontmatter.data.outputSchema);
        outputSchema = convertJsonSchemaToZod(json) as unknown as z.ZodSchema;
      } catch (e) {
        degraded.push({ skillId: filenameId, errors: [`outputSchema invalid: ${(e as Error).message}`] });
        continue;
      }
    }

    skills.push({
      id: frontmatter.data.id,
      name: frontmatter.data.name,
      description: frontmatter.data.description,
      version: frontmatter.data.version,
      tools: frontmatter.data.tools ?? [],
      canDispatch: frontmatter.data.canDispatch ?? [],
      systemPrompt: parsed.content,
      outputSchema,
      model: frontmatter.data.model,
      budget: frontmatter.data.budget
        ? {
            maxSteps: frontmatter.data.budget.maxSteps,
            maxTokensPerJob: frontmatter.data.budget.maxTokens,
          }
        : undefined,
    });
  }

  return { skills, degraded };
}
