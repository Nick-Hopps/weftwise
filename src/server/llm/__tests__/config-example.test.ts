import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LLMConfigFileSchema } from '../config-schema';

interface ExampleConfig {
  defaults: Record<string, unknown>;
  tasks: Record<string, Record<string, unknown>>;
}

const example = JSON.parse(
  readFileSync(resolve('llm-config.example.json'), 'utf8'),
) as ExampleConfig;
const jsonSchemaText = readFileSync(resolve('llm-config.schema.json'), 'utf8');

describe('llm-config.example.json', () => {
  it('通过运行时 schema，且不残留已废弃的采样参数', () => {
    expect(LLMConfigFileSchema.safeParse(example).success).toBe(true);
    expect(example.tasks.query).not.toHaveProperty('topP');
    expect(example.tasks.query).not.toHaveProperty('presencePenalty');
    expect(example.tasks.query).not.toHaveProperty('frequencyPenalty');
    expect(example.defaults).not.toHaveProperty('temperature');
  });

  it('至少有一个 task 演示 providerOptions —— 示例同时是文档', () => {
    // **刻意不锁定具体 provider 或 task**。上一版断言写死
    // `tasks.query.providerOptions.anthropic`，于是示例的默认供应商一换
    // （anthropic → deepseek，见 d8c79a1b）测试就红——让「示例挑了哪家」去决定
    // 测试红绿是错误的耦合。真正要守的不变量是：`providerOptions` 这个能力
    // 在示例里有活的演示，否则用户根本不知道它存在。
    const demos = Object.entries(example.tasks)
      .filter(([, cfg]) => 'providerOptions' in cfg)
      .map(([key]) => key);
    expect(demos.length, 'llm-config.example.json 里没有任何 providerOptions 演示').toBeGreaterThan(0);
  });

  it('覆盖全部当前 route key 且不声明工具 Profile ID', () => {
    const expected = [
      'query', 'lint', 'merge', 'split', 'curate', 'fix', 'embedding',
      'research:queries', 'research:triage',
      'ingest:planner', 'ingest:chunk-summarizer', 'ingest:writer', 'ingest:enricher', 'ingest:image',
      'ingest:verifier', 'ingest:verifier-triage', 'ingest:verifier-apply',
      'reenrich:supplement', 'reshape:page',
    ];

    expect(new Set(Object.keys(example.tasks))).toEqual(new Set(expected));
    expect(example.tasks).not.toHaveProperty('query:read');
    expect(example.tasks).not.toHaveProperty('fix:links');
    expect(example.tasks).not.toHaveProperty('curate:auto');
  });

  it('不预留未实现的段级重塑路由', () => {
    expect(example.tasks).not.toHaveProperty('reshape:section');
    expect(jsonSchemaText).not.toContain('"reshape:section"');
  });

  it('编辑器 JSON Schema 接受 adaptive/effort 且不再包含 indexer', () => {
    expect(jsonSchemaText).not.toContain('ingest:indexer');
    expect(jsonSchemaText).toContain('"adaptive"');
    expect(jsonSchemaText).toContain('"effort"');
    expect(jsonSchemaText).toContain('"research:queries"');
    expect(jsonSchemaText).not.toContain('"reshape:section"');
    expect(jsonSchemaText).toContain('"ingest:image"');
  });
});
