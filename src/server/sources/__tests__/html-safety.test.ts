import { describe, expect, it } from 'vitest';
import { analyzeHtmlSafety } from '../html-safety';

describe('analyzeHtmlSafety', () => {
  it('纯静态 HTML 判为 safe', () => {
    const html =
      '<!doctype html><html><head><title>Hi</title><style>p{color:red}</style></head>' +
      '<body><h1>标题</h1><p>正文段落</p><a href="https://example.com">链接</a></body></html>';
    const res = analyzeHtmlSafety(html);
    expect(res.risk).toBe('safe');
    expect(res.signals).toEqual([]);
  });

  it('含 eval() 判为 suspicious 并给出说明', () => {
    const res = analyzeHtmlSafety('<script>eval("alert(1)")</script>');
    expect(res.risk).toBe('suspicious');
    expect(res.signals.some((s) => s.includes('eval'))).toBe(true);
  });

  it('含外部脚本判为 suspicious', () => {
    const res = analyzeHtmlSafety('<script src="https://cdn.example.com/a.js"></script>');
    expect(res.risk).toBe('suspicious');
    expect(res.signals.some((s) => s.includes('外部脚本'))).toBe(true);
  });

  it('含 fetch / XHR 判为 suspicious', () => {
    expect(analyzeHtmlSafety('<script>fetch("/x")</script>').risk).toBe('suspicious');
    expect(analyzeHtmlSafety('<script>new XMLHttpRequest()</script>').risk).toBe('suspicious');
  });

  it('含 base64 + atob 混淆判为 suspicious', () => {
    const res = analyzeHtmlSafety('<script>eval(atob("YWxlcnQoMSk="))</script>');
    expect(res.risk).toBe('suspicious');
  });

  it('空串 / 纯空白判为 safe', () => {
    expect(analyzeHtmlSafety('').risk).toBe('safe');
    expect(analyzeHtmlSafety('   \n\t ').risk).toBe('safe');
  });
});
