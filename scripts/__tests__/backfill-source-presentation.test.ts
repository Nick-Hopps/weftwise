import { describe, expect, it } from 'vitest';
import { parseWebSnapshotPresentation } from '../backfill-source-presentation';

const RAW = [
  '# 从"国家"概念的出现到近代的全球史',
  '',
  'Source: https://news.gmw.cn/2026-01/content_36241753.htm',
  '',
  '国家概念的形成有一段漫长历史。',
  '',
  '第二段正文。',
].join('\n');

describe('parseWebSnapshotPresentation', () => {
  it('从导入格式的 raw 正文解析标题与首段描述', () => {
    expect(parseWebSnapshotPresentation(RAW)).toEqual({
      title: '从"国家"概念的出现到近代的全球史',
      description: '国家概念的形成有一段漫长历史。',
    });
  });

  it('标题为空时回退 Source 行的 hostname', () => {
    const raw = '# \n\nSource: https://www.worldhistory.org/1-18564/\n\n正文。';
    expect(parseWebSnapshotPresentation(raw)).toEqual({
      title: 'worldhistory.org',
      description: '正文。',
    });
  });

  it('缺少 Source 行或首行不是 H1 的文件不认作网页快照', () => {
    expect(parseWebSnapshotPresentation('# 标题\n\n没有来源行\n')).toBeNull();
    expect(parseWebSnapshotPresentation('普通笔记\n\nSource: https://a.com\n')).toBeNull();
  });

  it('只有标题没有正文时仍可回填标题', () => {
    expect(parseWebSnapshotPresentation('# 标题\n\nSource: https://a.com/x\n')).toEqual({
      title: '标题',
      description: undefined,
    });
  });
});
