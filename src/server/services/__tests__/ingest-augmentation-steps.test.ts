import { describe, it, expect } from 'vitest';
import { buildIngestSteps } from '../ingest-service';

const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline', 'languageDirective', 'augmentationDirective'];

describe('buildIngestSteps', () => {
  it('standard：含 writer + enricher + verify', () => {
    const steps = buildIngestSteps({ inline: true, level: 'standard', carryKeys });
    const kinds = steps.map((s) => ('skillId' in s ? s.skillId : s.kind));
    expect(kinds).toContain('ingest-enricher');
    expect(steps.some((s) => s.kind === 'verify')).toBe(true);
  });
  it('off：跳过 enricher 与 verify，仅到 writer', () => {
    const steps = buildIngestSteps({ inline: true, level: 'off', carryKeys });
    expect(steps.some((s) => 'skillId' in s && s.skillId === 'ingest-enricher')).toBe(false);
    expect(steps.some((s) => s.kind === 'verify')).toBe(false);
  });
  it('inline=false：含 chunk-summarizer map 头', () => {
    const steps = buildIngestSteps({ inline: false, level: 'standard', carryKeys });
    expect(steps[0].kind).toBe('map');
  });
});
