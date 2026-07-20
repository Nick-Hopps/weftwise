/**
 * 聊天工具活动展示：把 SSE tool-call 的 provider 工具名（点号已转下划线）
 * 映射为语义图标键 / 动词 / 参数摘要。client 与 server（query route）共用单一源。
 * 图标键由客户端映射为 Lucide 组件，避免把彩色 emoji 或 React 依赖写入 worker 日志。
 */
export type ToolActivityIconName =
  | 'activity'
  | 'compass'
  | 'file-diff'
  | 'file-pen'
  | 'file-plus'
  | 'file-text'
  | 'files'
  | 'globe'
  | 'image'
  | 'library'
  | 'link'
  | 'merge'
  | 'move-right'
  | 'search'
  | 'sparkles'
  | 'split'
  | 'stop'
  | 'tags'
  | 'telescope'
  | 'trash';

export function toolActivityIcon(tool: string): ToolActivityIconName {
  switch (tool) {
    case 'wiki_search': return 'search';
    case 'wiki_read': return 'file-text';
    case 'wiki_list': return 'files';
    case 'subject_list': return 'files';
    case 'wiki_search_cross_subject': return 'telescope';
    case 'wiki_read_cross_subject': return 'library';
    case 'wiki_reenrich':
    case 'workflow_reenrich_start': return 'sparkles';
    case 'workflow_research_start': return 'globe';
    case 'workflow_status': return 'compass';
    case 'workflow_cancel': return 'stop';
    case 'wiki_image_insert': return 'image';
    case 'wiki_create': return 'file-plus';
    case 'wiki_update': return 'file-pen';
    case 'wiki_patch': return 'file-diff';
    case 'wiki_metadata_patch': return 'tags';
    case 'wiki_link_ensure': return 'link';
    case 'wiki_delete': return 'trash';
    case 'wiki_move': return 'move-right';
    case 'wiki_merge': return 'merge';
    case 'wiki_split': return 'split';
    case 'web_search': return 'globe';
    default: return 'activity';
  }
}

export function toolActivityVerb(tool: string): string {
  switch (tool) {
    case 'wiki_search': return 'Searching';
    case 'wiki_read': return 'Reading';
    case 'wiki_list': return 'Listing pages';
    case 'subject_list': return 'Listing subjects';
    case 'wiki_search_cross_subject': return 'Searching subjects';
    case 'wiki_read_cross_subject': return 'Reading another subject';
    case 'wiki_reenrich':
    case 'workflow_reenrich_start': return 'Planning re-enrichment';
    case 'workflow_research_start': return 'Planning research';
    case 'workflow_status': return 'Checking workflow';
    case 'workflow_cancel': return 'Planning cancellation';
    case 'wiki_image_insert': return 'Planning illustration';
    case 'wiki_create': return 'Creating';
    case 'wiki_update': return 'Editing';
    case 'wiki_patch': return 'Patching';
    case 'wiki_metadata_patch': return 'Editing metadata';
    case 'wiki_link_ensure': return 'Maintaining link';
    case 'wiki_delete': return 'Deleting';
    case 'wiki_move': return 'Planning page move';
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
  if (tool === 'wiki_search_cross_subject') {
    const query = typeof a.query === 'string' ? a.query : '';
    const subjects = Array.isArray(a.subjectSlugs)
      ? a.subjectSlugs.filter((value): value is string => typeof value === 'string').join(', ')
      : '';
    return [subjects, query].filter(Boolean).join(': ');
  }
  if (tool === 'wiki_read_cross_subject') {
    const subject = typeof a.subjectSlug === 'string' ? a.subjectSlug : '';
    const slug = typeof a.slug === 'string' ? a.slug : '';
    return subject && slug ? `${subject}:${slug}` : slug;
  }
  if (
    tool === 'wiki_read'
    || tool === 'wiki_reenrich'
    || tool === 'workflow_reenrich_start'
  ) return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'workflow_research_start') return typeof a.topic === 'string' ? a.topic : '';
  if (tool === 'workflow_status' || tool === 'workflow_cancel') {
    return typeof a.jobId === 'string' ? a.jobId : '';
  }
  if (tool === 'wiki_image_insert') {
    return typeof a.prompt === 'string' ? a.prompt.slice(0, 120) : '';
  }
  if (tool === 'wiki_delete') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_move') {
    const from = typeof a.slug === 'string' ? a.slug : '';
    const to = typeof a.newSlug === 'string' ? a.newSlug : '';
    return from && to ? `${from} → ${to}` : from || to;
  }
  if (tool === 'wiki_create') return typeof a.title === 'string' ? a.title : '';
  if (tool === 'wiki_update') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_patch') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_metadata_patch') {
    const slug = typeof a.slug === 'string' ? a.slug : '';
    const fields = ['title', 'summary', 'tags', 'aliases']
      .filter((field) => a[field] !== undefined);
    return slug && fields.length > 0 ? `${slug} (${fields.join(', ')})` : slug;
  }
  if (tool === 'wiki_link_ensure') {
    const source = typeof a.sourceSlug === 'string' ? a.sourceSlug : '';
    const mode = typeof a.mode === 'string' ? a.mode : '';
    const targetSlug = typeof a.targetSlug === 'string' ? a.targetSlug : '';
    const targetSubject = typeof a.targetSubjectSlug === 'string' ? a.targetSubjectSlug : '';
    const target = targetSubject && targetSlug ? `${targetSubject}:${targetSlug}` : targetSlug;
    return [source, mode, target].filter(Boolean).join(' ');
  }
  if (tool === 'wiki_merge') {
    const s = typeof a.sourceSlug === 'string' ? a.sourceSlug : '';
    const t = typeof a.targetSlug === 'string' ? a.targetSlug : '';
    return s && t ? `${s} → ${t}` : s || t;
  }
  if (tool === 'wiki_split') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'web_search') return typeof a.query === 'string' ? a.query : '';
  return '';
}

/** 组装可复制的纯文本日志文案；视觉图标由客户端根据事件中的 tool 字段渲染。 */
export function toolActivityLine(tool: string, args: unknown): string {
  const summary = summarizeToolArgs(tool, args);
  const head = toolActivityVerb(tool);
  return summary ? `${head} "${summary}"…` : `${head}…`;
}

const LEGACY_TOOL_ACTIVITY_PREFIXES = [
  '\u{23F9}\u{FE0F}', '\u{1F5BC}\u{FE0F}', '\u{270F}\u{FE0F}',
  '\u{21AA}\u{FE0F}', '\u{2702}\u{FE0F}', '\u{1F50D}', '\u{1F4C4}',
  '\u{1F5C2}', '\u{1F52D}', '\u{1F4DA}', '\u{2728}', '\u{1F310}',
  '\u{1F9ED}', '\u{2795}', '\u{1F517}', '\u{1F5D1}', '\u{2022}',
] as const;

/** 仅清理旧版工具事件写入的行首 emoji；普通用户内容不应调用此函数。 */
export function stripLegacyToolActivityIcon(message: string): string {
  for (const prefix of LEGACY_TOOL_ACTIVITY_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length).trimStart();
  }
  return message;
}

/** SSE 将业务 data 包在顶层 data 字段内；同时兼容测试/旧调用方的扁平形态。 */
export function toolNameFromEvent(event: { data?: Record<string, unknown> }): string | null {
  const data = event.data ?? {};
  const nested = data.data;
  const nestedTool = nested && typeof nested === 'object'
    ? (nested as Record<string, unknown>).tool
    : undefined;
  const tool = nestedTool ?? data.tool;
  return typeof tool === 'string' && tool.length > 0 ? tool : null;
}

export function latestToolName(events: readonly { data?: Record<string, unknown> }[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index].data ?? {};
    const updatesLatestMessage = [data.message, data.step, data.description]
      .some((value) => typeof value === 'string' && value.length > 0);
    if (updatesLatestMessage) return toolNameFromEvent(events[index]);
  }
  return null;
}

/** 根据 SSE 事件识别 job 活动标题，供进度条与详情弹窗共用。 */
export function jobActivityTitle(events: readonly { type: string }[]): MessageKey {
  for (const event of events) {
    if (event.type.startsWith('research-import')) return 'jobs.activity.researchImport';
    if (event.type.startsWith('research')) return 'jobs.activity.research';
    if (event.type.startsWith('ingest')) return 'jobs.activity.ingest';
    if (event.type.startsWith('lint')) return 'jobs.activity.lint';
  }
  return 'jobs.activity.processing';
}
import type { MessageKey } from '@/lib/i18n/messages';
