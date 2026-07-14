import { describe, expect, it } from 'vitest';
import { resolveQueryMode } from '../query-intent';

describe('resolveQueryMode', () => {
  it.each([
    '请创建一个 Wiki 页面，标题是量子计算',
    '把页面 old-note 更新为下面的内容',
    '局部修改 wiki 页面 eigenvalue 的第二段',
    '请删除知识库页面 obsolete',
    '重新丰富页面 linear-algebra',
    'Create a wiki page named Quantum Computing',
    'Update the page eigenvalue',
    'Patch wiki page eigenvalue',
    'Delete the wiki page obsolete',
    'Re-enrich the page linear-algebra',
    '回滚历史操作 op-123',
    '把知识库版本 op-123 恢复到变更前',
    'Revert wiki history operation op-123',
    '开始研究 SQLite WAL',
    '启动 Research：SQLite WAL',
    'Start research on SQLite WAL',
    '取消任务 job-123',
    '终止工作流 job-123',
    'Cancel job job-123',
    '把页面 old-page 移动到 new-page',
    '把 Wiki 页面 old-page 的 slug 改成 new-page',
    'Rename the wiki page slug from old-page to new-page',
  ])('明确写入命令进入 propose：%s', (question) => {
    expect(resolveQueryMode(question)).toBe('propose');
  });

  it.each([
    '如何删除 wiki 页面？',
    '你能创建页面吗？',
    '不要删除页面 obsolete',
    '假设我更新这个页面会怎样？',
    'How do I delete a wiki page?',
    'Can you create pages?',
    'Do not update the page eigenvalue',
    'What would happen if I delete this page?',
    '如何回滚历史操作？',
    '不要回滚知识库版本 op-123',
    '如何启动 Research？',
    '你能取消任务吗？',
    '不要取消任务 job-123',
    'How do I start research?',
    'Can you cancel a job?',
    'Do not cancel job job-123',
    '如何移动 Wiki 页面？',
    '不要把页面 old-page 改成 new-page',
    'How do I rename a wiki page slug?',
    '总结一下量子计算',
  ])('教程、能力、否定和普通问答保持 read：%s', (question) => {
    expect(resolveQueryMode(question)).toBe('read');
  });
});
