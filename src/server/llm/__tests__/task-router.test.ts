/**
 * task-router.resolveTask 单元测试。
 *
 * Mock 策略：把 config-loader.getLLMConfig 替换为可变的内存配置，
 * 避免读真实 llm-config.json。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMConfigFile } from '../config-schema';
import { LLMTaskSchema } from '../config-schema';

const loaderMocks = vi.hoisted(() => ({
  getLLMConfig: vi.fn(),
}));
vi.mock('../config-loader', () => loaderMocks);

import { resolveTask } from '../task-router';
import { LLMConfigError } from '../errors';

function makeConfig(overrides: Partial<LLMConfigFile> = {}): LLMConfigFile {
  return {
    version: 1,
    defaults: {
      profile: 'primary',
      model: 'default-model',
      maxTokens: 1000,
      temperature: 0.5,
      timeoutMs: 60_000,
    },
    tasks: {
      'ingest:writer': { temperature: 0.2, model: 'ingest-model' },
      'ingest:planner': { profile: 'cheap', model: 'planner-model', temperature: 0.1 },
    },
    providers: {
      primary: { provider: 'anthropic' },
      cheap: { provider: 'openai' },
      compat: { provider: 'openai-compatible', name: 'my-gateway', baseURL: 'http://localhost:8080' },
    },
    ...overrides,
  } as LLMConfigFile;
}

beforeEach(() => {
  loaderMocks.getLLMConfig.mockReturnValue(makeConfig());
});

describe('resolveTask 三层合并', () => {
  it('未配置的 task 回退 defaults', () => {
    // 'query' 不在 tasks 节中
    const route = resolveTask('query');
    expect(route.profileName).toBe('primary');
    expect(route.model).toBe('default-model');
    expect(route.temperature).toBe(0.5);
    expect(route.maxTokens).toBe(1000);
    expect(route.timeoutMs).toBe(60_000);
    expect(route.logLabel).toBe('anthropic:default-model');
  });

  it('task 配置覆盖 defaults，未指定字段沿用 defaults', () => {
    const route = resolveTask('ingest:writer');
    expect(route.model).toBe('ingest-model'); // task 覆盖
    expect(route.temperature).toBe(0.2); // task 覆盖
    expect(route.profileName).toBe('primary'); // 沿用 defaults
    expect(route.maxTokens).toBe(1000); // 沿用 defaults
  });

  it('调用点 override 优先级最高（defaults < task < override）', () => {
    const route = resolveTask('ingest:writer', {
      model: 'override-model',
      temperature: 0.9,
      profile: 'cheap',
    });
    expect(route.model).toBe('override-model');
    expect(route.temperature).toBe(0.9);
    expect(route.profileName).toBe('cheap');
    expect(route.provider.provider).toBe('openai');
  });

  it('override 中显式 undefined 的字段不会 clobber 下层值', () => {
    const route = resolveTask('ingest:writer', { model: undefined, temperature: undefined });
    expect(route.model).toBe('ingest-model');
    expect(route.temperature).toBe(0.2);
  });

  it('task 配置中显式 undefined 的字段同样不会 clobber defaults', () => {
    loaderMocks.getLLMConfig.mockReturnValue(
      makeConfig({ tasks: { 'ingest:writer': { model: undefined } } as LLMConfigFile['tasks'] })
    );
    const route = resolveTask('ingest:writer');
    expect(route.model).toBe('default-model');
  });
});

describe('resolveTask <pipeline>:<stage> 任务', () => {
  it('<pipeline>:<stage> 命中 tasks 节中的同名 key', () => {
    const route = resolveTask('ingest:planner');
    expect(route.task).toBe('ingest:planner');
    expect(route.profileName).toBe('cheap');
    expect(route.model).toBe('planner-model');
    expect(route.temperature).toBe(0.1);
  });

  it('未配置的 <pipeline>:<stage> 回退 defaults（config.tasks[task] ?? {}）', () => {
    const route = resolveTask('ingest:not-configured');
    expect(route.profileName).toBe('primary');
    expect(route.model).toBe('default-model');
  });
});

describe('resolveTask 错误与缺省值', () => {
  it('解析后缺 profile 抛 LLMConfigError', () => {
    loaderMocks.getLLMConfig.mockReturnValue(
      makeConfig({
        defaults: { profile: '', model: 'm' } as LLMConfigFile['defaults'],
      })
    );
    // 疑点：defaults.profile 为空串在 schema 层不合法，但 resolveTask 运行时
    // 用 falsy 判断（!merged.profile）兜底——按实际行为断言抛错
    expect(() => resolveTask('query')).toThrow(LLMConfigError);
    expect(() => resolveTask('query')).toThrow(/without a provider profile/);
  });

  it('解析后缺 model 抛 LLMConfigError', () => {
    loaderMocks.getLLMConfig.mockReturnValue(
      makeConfig({
        defaults: { profile: 'primary', model: '' } as LLMConfigFile['defaults'],
      })
    );
    expect(() => resolveTask('query')).toThrow(/without a model/);
  });

  it('引用不存在的 provider profile 抛 LLMConfigError 并列出可用 profile', () => {
    expect(() => resolveTask('query', { profile: 'ghost' })).toThrow(
      /unknown provider profile "ghost".*primary, cheap, compat/
    );
  });

  it('maxTokens / timeoutMs 缺省时落到内置默认值', () => {
    loaderMocks.getLLMConfig.mockReturnValue(
      makeConfig({
        defaults: { profile: 'primary', model: 'm' } as LLMConfigFile['defaults'],
      })
    );
    const route = resolveTask('query');
    expect(route.maxTokens).toBe(8192);
    expect(route.timeoutMs).toBe(8 * 60 * 1000);
  });

  it('openai-compatible 的 logLabel 使用自定义 name', () => {
    const route = resolveTask('query', { profile: 'compat', model: 'm-x' });
    expect(route.logLabel).toBe('my-gateway:m-x');
  });
});

describe('LLMTaskSchema', () => {
  it('接受 builtin 与 <pipeline>:<stage>', () => {
    for (const t of ['query', 'lint', 'embedding', 'ingest:planner', 'ingest:verifier-triage']) {
      expect(LLMTaskSchema.safeParse(t).success).toBe(true);
    }
  });
  it('拒绝已移除的 ingest（无冒号、非 builtin）', () => {
    expect(LLMTaskSchema.safeParse('ingest').success).toBe(false);
  });
});
