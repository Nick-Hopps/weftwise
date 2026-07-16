import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LLMConfigFileSchema } from '../config-schema';

interface ExampleConfig {
  defaults: Record<string, unknown>;
  tasks: Record<string, Record<string, unknown>> & {
    query: Record<string, unknown> & {
      providerOptions: { anthropic: unknown };
    };
  };
}

const example = JSON.parse(
  readFileSync(resolve('llm-config.example.json'), 'utf8'),
) as ExampleConfig;
const jsonSchemaText = readFileSync(resolve('llm-config.schema.json'), 'utf8');

describe('llm-config.example.json', () => {
  it('通过运行时 schema 且 Query 使用 Sonnet 4.6 adaptive thinking', () => {
    expect(LLMConfigFileSchema.safeParse(example).success).toBe(true);
    expect(example.tasks.query.providerOptions.anthropic).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'medium',
    });
    expect(example.tasks.query).not.toHaveProperty('topP');
    expect(example.tasks.query).not.toHaveProperty('presencePenalty');
    expect(example.tasks.query).not.toHaveProperty('frequencyPenalty');
    expect(example.defaults).not.toHaveProperty('temperature');
  });

  it('覆盖全部当前 route key 且不声明工具 Profile ID', () => {
    const expected = [
      'query', 'lint', 'merge', 'split', 'curate', 'fix', 'embedding',
      'research:queries', 'research:triage',
      'ingest:planner', 'ingest:chunk-summarizer', 'ingest:writer', 'ingest:enricher', 'ingest:image',
      'ingest:verifier', 'ingest:verifier-triage', 'ingest:verifier-apply',
      'reenrich:supplement', 'reshape:page', 'reshape:section',
    ];

    expect(new Set(Object.keys(example.tasks))).toEqual(new Set(expected));
    expect(example.tasks).not.toHaveProperty('query:read');
    expect(example.tasks).not.toHaveProperty('fix:links');
    expect(example.tasks).not.toHaveProperty('curate:auto');
  });

  it('编辑器 JSON Schema 接受 adaptive/effort 且不再包含 indexer', () => {
    expect(jsonSchemaText).not.toContain('ingest:indexer');
    expect(jsonSchemaText).toContain('"adaptive"');
    expect(jsonSchemaText).toContain('"effort"');
    expect(jsonSchemaText).toContain('"research:queries"');
    expect(jsonSchemaText).toContain('"reshape:section"');
    expect(jsonSchemaText).toContain('"ingest:image"');
  });
});
