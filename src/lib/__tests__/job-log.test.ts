import { describe, it, expect } from 'vitest';
import { eventLogLine, parseJobError } from '../job-log';

describe('eventLogLine', () => {
  it('uses top-level message as the text', () => {
    expect(eventLogLine({ type: 'ingest:llm', data: { message: 'A' } }).text).toBe('A');
  });

  it('exposes the semantic tool name and removes legacy emoji from log text', () => {
    expect(eventLogLine({
      type: 'fix:tool',
      data: { message: '✏️ Editing "page-a"…', data: { tool: 'wiki_update' } },
    })).toMatchObject({
      text: 'Editing "page-a"…',
      tool: 'wiki_update',
    });
  });

  it('does not strip emoji from ordinary non-tool event messages', () => {
    expect(eventLogLine({
      type: 'ingest:complete',
      data: { message: '保留用户内容 🚀' },
    }).text).toBe('保留用户内容 🚀');
  });

  it('falls back to event.type when message is absent or empty', () => {
    expect(eventLogLine({ type: 'ingest:start', data: {} }).text).toBe('ingest:start');
    expect(eventLogLine({ type: 'job:failed', data: { message: '' } }).text).toBe('job:failed');
  });

  it('flags error events', () => {
    expect(eventLogLine({ type: 'job:failed', data: {} }).isError).toBe(true);
    expect(eventLogLine({ type: 'lint:semantic:error', data: {} }).isError).toBe(true);
    expect(eventLogLine({ type: 'ingest:start', data: {} }).isError).toBe(false);
  });

  it('formats createdAt as HH:mm:ss and tolerates missing/invalid', () => {
    const iso = '2026-06-28T12:03:45.000Z';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(eventLogLine({ type: 't', data: { createdAt: iso } }).time)
      .toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    expect(eventLogLine({ type: 't', data: {} }).time).toBe('');
    expect(eventLogLine({ type: 't', data: { createdAt: 'nonsense' } }).time).toBe('');
  });
});

describe('parseJobError', () => {
  it('returns null for empty/invalid input', () => {
    expect(parseJobError(null)).toBeNull();
    expect(parseJobError(undefined)).toBeNull();
    expect(parseJobError('')).toBeNull();
    expect(parseJobError('{not json')).toBeNull();
  });

  it('returns null when no error field', () => {
    expect(parseJobError(JSON.stringify({ pagesCreated: [] }))).toBeNull();
  });

  it('extracts message and optional technical fields', () => {
    const json = JSON.stringify({
      error: {
        message: 'boom',
        stack: 'Error: boom\n  at x',
        cause: 'root cause',
        responseText: 'raw',
        finishReason: 'length',
        usage: { totalTokens: 9 },
      },
    });
    const e = parseJobError(json);
    expect(e).not.toBeNull();
    expect(e!.message).toBe('boom');
    expect(e!.stack).toContain('at x');
    expect(e!.cause).toBe('root cause');
    expect(e!.responseText).toBe('raw');
    expect(e!.finishReason).toBe('length');
    expect(e!.usage).toEqual({ totalTokens: 9 });
  });

  it('falls back message when missing', () => {
    const e = parseJobError(JSON.stringify({ error: { stack: 's' } }));
    expect(e!.message).toBe('Job failed');
  });

  it('stringifies non-string cause', () => {
    const e = parseJobError(JSON.stringify({ error: { message: 'm', cause: { code: 'E' } } }));
    expect(e!.cause).toBe(JSON.stringify({ code: 'E' }));
  });
});
