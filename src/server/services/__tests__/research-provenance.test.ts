import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeResearchSelection,
  parseResearchCandidateSnapshot,
  prepareResearchCandidates,
  researchApprovalPayloadHash,
  researchCandidateId,
  researchCandidateSetHash,
  normalizeResearchCandidateUrl,
  ResearchProvenanceError,
  validateStoredResearchCandidates,
} from '../research-provenance';

describe('Research provenance 纯函数', () => {
  it('规范化 URL 身份：host 小写、去 hash/default port/trailing slash，保留 query', () => {
    expect(normalizeResearchCandidateUrl(' HTTPS://Example.COM:443/a/../docs/?q=1#part '))
      .toBe('https://example.com/docs?q=1');
  });

  it.each([
    'file:///tmp/secret',
    'http://127.0.0.1/private',
    'https://user:pass@example.com/',
    'not-a-url',
  ])('拒绝不可作为公开 HTTP 候选的 URL：%s', (url) => {
    expect(() => normalizeResearchCandidateUrl(url)).toThrow();
  });

  it('candidate ID 严格由 runId 与规范化 URL 派生', () => {
    const normalizedUrl = 'https://example.com/docs';
    expect(researchCandidateId('run-1', normalizedUrl)).toBe(
      createHash('sha256').update(`run-1\n${normalizedUrl}`).digest('hex'),
    );
  });

  it('候选集 hash 对同一稳定快照可重放，顺序或快照变化会改变', () => {
    const prepared = prepareResearchCandidates([
      { url: 'https://example.com/a/', title: 'A', snippet: 'a', score: 3, reason: '好' },
      { url: 'https://example.com/b', title: 'B', snippet: 'b', score: null, reason: null },
    ]);
    expect(researchCandidateSetHash(prepared)).toBe(researchCandidateSetHash(structuredClone(prepared)));
    const reversed = [...prepared].reverse().map((candidate, rank) => ({ ...candidate, rank }));
    expect(researchCandidateSetHash(reversed)).not.toBe(researchCandidateSetHash(prepared));
    expect(researchCandidateSetHash([
      prepared[0]!,
      { ...prepared[1]!, snapshot: { ...prepared[1]!.snapshot, title: 'changed' } },
    ])).not.toBe(researchCandidateSetHash(prepared));
  });

  it('候选准备保留最终顺序并拒绝规范化后的重复 URL', () => {
    const prepared = prepareResearchCandidates([
      { url: 'https://example.com/b', title: 'B', snippet: '', score: 2, reason: 'ok' },
      { url: 'https://example.com/a', title: 'A', snippet: '', score: 3, reason: 'great' },
    ]);
    expect(prepared.map((candidate) => [candidate.rank, candidate.normalizedUrl]))
      .toEqual([[0, 'https://example.com/b'], [1, 'https://example.com/a']]);
    expect(prepareResearchCandidates([
      { url: 'https://EXAMPLE.com/a/#fragment', title: 'A', snippet: '', score: 3, reason: null },
    ])[0]!.snapshot.url).toBe('https://example.com/a');

    expect(() => prepareResearchCandidates([
      { url: 'https://EXAMPLE.com/a/', title: 'A', snippet: '', score: 3, reason: null },
      { url: 'https://example.com/a#fragment', title: 'A2', snippet: '', score: 2, reason: null },
    ])).toThrow(ResearchProvenanceError);
  });

  it('批准 selection canonical sort 后计算 payload hash，版本与选择变化均改变 hash', () => {
    const selection = canonicalizeResearchSelection(['candidate-b', 'candidate-a']);
    expect(selection).toEqual(['candidate-a', 'candidate-b']);
    expect(researchApprovalPayloadHash('run-1', 1, selection))
      .toBe(researchApprovalPayloadHash('run-1', 1, ['candidate-b', 'candidate-a']));
    expect(researchApprovalPayloadHash('run-1', 2, selection))
      .not.toBe(researchApprovalPayloadHash('run-1', 1, selection));
    expect(researchApprovalPayloadHash('run-1', 1, ['candidate-a']))
      .not.toBe(researchApprovalPayloadHash('run-1', 1, selection));
  });

  it.each([[[]], [['candidate-a', 'candidate-a']]])('拒绝空选择或重复 ID：%j', (selection) => {
    expect(() => canonicalizeResearchSelection(selection)).toThrow(ResearchProvenanceError);
  });

  it('候选 snapshot 严格校验字段、score 和持久化身份', () => {
    const snapshot = parseResearchCandidateSnapshot({
      id: 'a'.repeat(64),
      normalizedUrl: 'https://example.com/a',
      rank: 0,
      url: 'https://example.com/a',
      title: 'A',
      snippet: 'snippet',
      score: 3,
      reason: 'good',
    });
    expect(snapshot.title).toBe('A');
    expect(() => parseResearchCandidateSnapshot({ ...snapshot, score: 4 })).toThrow();
    expect(() => parseResearchCandidateSnapshot({ ...snapshot, unexpected: true })).toThrow();
    expect(() => parseResearchCandidateSnapshot({ ...snapshot, normalizedUrl: 'http://127.0.0.1' })).toThrow();
  });

  it('整组持久化证据对 snapshot、ID、rank 与 candidate set hash 漂移 fail-closed', () => {
    const runId = 'run-1';
    const prepared = prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: 'good' },
    ]);
    const hash = researchCandidateSetHash(prepared);
    const row = {
      id: researchCandidateId(runId, prepared[0]!.normalizedUrl),
      normalizedUrl: prepared[0]!.normalizedUrl,
      snapshotJson: JSON.stringify(prepared[0]!.snapshot),
      rank: 0,
    };
    expect(validateStoredResearchCandidates(runId, hash, [row])).toHaveLength(1);
    expect(() => validateStoredResearchCandidates(runId, hash, [
      { ...row, snapshotJson: '{' },
    ])).toThrow();
    expect(() => validateStoredResearchCandidates(runId, hash, [
      { ...row, id: 'a'.repeat(64) },
    ])).toThrow();
    expect(() => validateStoredResearchCandidates(runId, hash, [
      { ...row, rank: 1 },
    ])).toThrow();
    expect(() => validateStoredResearchCandidates(runId, '0'.repeat(64), [row])).toThrow();
  });
});
