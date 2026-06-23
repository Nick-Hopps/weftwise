import type { HtmlSafety } from '@/lib/contracts';

/** 高危信号规则：正则命中即记一条中文说明（大小写不敏感，未用 /g 故无状态问题）。 */
const RULES: { test: RegExp; signal: string }[] = [
  { test: /\beval\s*\(/i, signal: '使用了 eval() 动态执行代码' },
  { test: /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"]/i, signal: '使用了 Function() 构造动态代码' },
  { test: /document\s*\.\s*write(ln)?\s*\(/i, signal: '使用了 document.write 动态写入' },
  { test: /<script\b[^>]*\bsrc\s*=/i, signal: '引入了外部脚本 <script src>' },
  {
    test: /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket\s*\(|navigator\s*\.\s*sendBeacon/i,
    signal: '含网络请求（可能外发数据）',
  },
  {
    test: /\batob\s*\(|\bunescape\s*\(|String\s*\.\s*fromCharCode\s*\(/i,
    signal: '含编码/混淆代码（atob / fromCharCode）',
  },
  { test: /<meta\b[^>]*http-equiv\s*=\s*['"]?\s*refresh/i, signal: '含自动跳转 meta refresh' },
  { test: /<(iframe|object|embed)\b/i, signal: '内嵌了其它框架/对象（iframe/object/embed）' },
  {
    test: /location\s*\.\s*(href|replace)\b|window\s*\.\s*open\s*\(|top\s*\.\s*location/i,
    signal: '含页面跳转 / 弹窗',
  },
  { test: /document\s*\.\s*cookie|localStorage|sessionStorage/i, signal: '访问了 cookie / 本地存储' },
];

/** <script> 块内出现超长无空白串视为混淆。 */
const OBFUSCATION = /<script\b[^>]*>[^]*?[^\s'"<>]{1000,}[^]*?<\/script>/i;

/**
 * 启发式扫描 HTML 原文，判断是否含可疑脚本。
 *
 * 注意：这不是安全保证——可被绕过、会误报漏报。真正的边界是 iframe 的
 * opaque origin（sandbox 不含 allow-same-origin）+ raw 路由 CSP。此函数仅作
 * 「是否自动放行脚本」的保守判据与 UX 警告文案来源。
 */
export function analyzeHtmlSafety(html: string): HtmlSafety {
  const signals: string[] = [];
  for (const rule of RULES) {
    if (rule.test.test(html)) signals.push(rule.signal);
  }
  if (OBFUSCATION.test(html)) signals.push('含超长无空白脚本串（疑似混淆）');
  return { risk: signals.length > 0 ? 'suspicious' : 'safe', signals };
}
