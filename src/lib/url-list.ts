/** 多行 URL 输入解析：按行拆分、trim、去空、去重、http(s) 前缀校验。 */
export function parseUrlLines(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!/^https?:\/\//i.test(t)) {
      invalid.push(t);
    } else if (!urls.includes(t)) {
      urls.push(t);
    }
  }
  return { urls, invalid };
}
