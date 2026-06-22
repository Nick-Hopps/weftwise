import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetConfig = vi.fn();
vi.mock('../config-loader', () => ({ getLLMConfig: () => mockGetConfig() }));
vi.mock('../task-router', () => ({ resolveTask: () => ({ model: 'text-embedding-3-small' }) }));
vi.mock('../provider-factory', () => ({ getEmbeddingModel: vi.fn(), getLanguageModel: vi.fn() }));

import { isEmbeddingConfigured } from '../provider-registry';

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
