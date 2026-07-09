/**
 * 聊天工具活动展示：把 SSE tool-call 的 provider 工具名（点号已转下划线）
 * 映射为图标 / 动词 / 参数摘要。client 与 server（query route）共用单一源。
 */
export function toolActivityIcon(tool: string): string {
  switch (tool) {
    case 'wiki_search': return '🔍';
    case 'wiki_read': return '📄';
    case 'wiki_list': return '🗂';
    case 'wiki_reenrich': return '✨';
    case 'wiki_create': return '➕';
    case 'wiki_update': return '✏️';
    case 'wiki_patch': return '✏️';
    case 'wiki_delete': return '🗑';
    case 'wiki_merge': return '🔗';
    case 'wiki_split': return '✂️';
    case 'web_search': return '🌐';
    default: return '•';
  }
}

export function toolActivityVerb(tool: string): string {
  switch (tool) {
    case 'wiki_search': return 'Searching';
    case 'wiki_read': return 'Reading';
    case 'wiki_list': return 'Listing pages';
    case 'wiki_reenrich': return 'Re-enriching';
    case 'wiki_create': return 'Creating';
    case 'wiki_update': return 'Editing';
    case 'wiki_patch': return 'Patching';
    case 'wiki_delete': return 'Deleting';
    case 'wiki_merge': return 'Merging';
    case 'wiki_split': return 'Splitting';
    case 'web_search': return 'Searching the web';
    default: return tool;
  }
}

/** 把工具调用入参压成一行给前端展示（不外发完整 result，避免泄漏正文）。 */
export function summarizeToolArgs(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === 'wiki_search') return typeof a.query === 'string' ? a.query : '';
  if (tool === 'wiki_read' || tool === 'wiki_reenrich') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_delete') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_create') return typeof a.title === 'string' ? a.title : '';
  if (tool === 'wiki_update') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_patch') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_merge') {
    const s = typeof a.sourceSlug === 'string' ? a.sourceSlug : '';
    const t = typeof a.targetSlug === 'string' ? a.targetSlug : '';
    return s && t ? `${s} → ${t}` : s || t;
  }
  if (tool === 'wiki_split') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'web_search') return typeof a.query === 'string' ? a.query : '';
  return '';
}

/** 组装单行日志文案（供 job 事件日志用），如 `📄 Reading "some-page"…`。 */
export function toolActivityLine(tool: string, args: unknown): string {
  const summary = summarizeToolArgs(tool, args);
  const head = `${toolActivityIcon(tool)} ${toolActivityVerb(tool)}`;
  return summary ? `${head} "${summary}"…` : `${head}…`;
}
