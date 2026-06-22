import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetConfig = vi.fn();
vi.mock('../config-loader', () => ({ getLLMConfig: () => mockGetConfig() }));
vi.mock('../task-router', () => ({ resolveTask: () => ({ model: 'text-embedding-3-small' }) }));
vi.mock('../provider-factory', () => ({ getEmbeddingModel: vi.fn(), getLanguageModel: vi.fn() }));

import { isEmbeddingConfigured, embeddingModelId, generateEmbeddings } from '../provider-registry';

beforeEach(() => mockGetConfig.mockReset());

describe('isEmbeddingConfigured', () => {
  it('tasks.embedding.model 存在 → true', () => {
    mockGetConfig.mockReturnValue({ tasks: { embedding: { model: 'text-embedding-3-small' } } });
    expect(isEmbeddingConfigured()).toBe(true);
  });
  it('无 tasks.embedding → false', () => {
    mockGetConfig.mockReturnValue({ tasks: {} });
    expect(isEmbeddingConfigured()).toBe(false);
  });
  it('tasks.embedding 无 model → false', () => {
    mockGetConfig.mockReturnValue({ tasks: { embedding: {} } });
    expect(isEmbeddingConfigured()).toBe(false);
  });
});

describe('embeddingModelId guard', () => {
  it('未配置 embedding → 抛 LLMConfigError', () => {
    mockGetConfig.mockReturnValue({ tasks: {} });
    expect(() => embeddingModelId()).toThrow(/Embedding model not configured/);
  });
});

describe('generateEmbeddings guard', () => {
  it('未配置 embedding → reject LLMConfigError', async () => {
    mockGetConfig.mockReturnValue({ tasks: {} });
    await expect(generateEmbeddings(['test'])).rejects.toThrow(/Embedding model not configured/);
  });
});
