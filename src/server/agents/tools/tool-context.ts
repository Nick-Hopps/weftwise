import type {
  CrossSubjectReadInput,
  CrossSubjectReadResult,
  CrossSubjectSearchInput,
  CrossSubjectSearchResult,
  HistoryDiffInput,
  HistoryDiffResult,
  HistoryListInput,
  HistoryListResult,
  InspectSection,
  LinkEnsureInput,
  LinkEnsureResult,
  MetadataPatchInput,
  MetadataPatchResult,
  PageListInput,
  PageListResult,
  SourceReadInput,
  SourceReadResult,
  SourceSearchInput,
  SourceSearchResult,
  Subject,
  SubjectToolListResult,
  WikiInspection,
  PendingActionView,
  PreviewChangeInput,
  WorkflowStatusResult,
} from '@/lib/contracts';
import type { AgentContext } from '../types';
import { parseFrontmatter } from '@/server/wiki/frontmatter';
import { createSubjectEvidenceReader } from './evidence-reader';
import {
  generateImageAsset,
  type ImageGenerateInput,
  type ImageGenerateOutput,
} from './builtin/image-generate';

/**
 * 工具执行上下文（DI 接缝）：工具只声明 schema + 记录访问，数据源由 ctx 注入。
 * ingest 提供 overlay-backed 实现；query 提供已提交+混合检索实现（见 query-tools.ts）。
 */
export interface ToolContext {
  subject: Subject;
  conversationId?: string;
  previewChange?(input: PreviewChangeInput): Promise<PendingActionView>;
  /** Query 专用：为 active Subject 的历史 operation 创建回滚审批。 */
  previewHistoryRevert?(operationId: string): Promise<PendingActionView>;
  /** Query 专用：为 re-enrich 工作流创建审批，不直接入队。 */
  previewWorkflowReenrich?(slug: string): Promise<PendingActionView>;
  /** Query 专用：为自由主题 Research 创建审批，不直接入队。 */
  previewWorkflowResearch?(topic: string): Promise<PendingActionView>;
  /** Query 专用：为 active Subject job 创建取消审批。 */
  previewWorkflowCancel?(jobId: string): Promise<PendingActionView>;
  /** Query 专用：为请求中可信 canonical 选区创建单图插入审批。 */
  previewImageInsert?(input: ImageGenerateInput): Promise<PendingActionView>;
  onPendingAction?(action: PendingActionView): void;
  readPage(slug: string): Promise<{ title: string; markdown: string } | null>;
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; summary: string }>>;
  inspectPage?(slug: string, include?: InspectSection[]): Promise<WikiInspection>;
  searchSources?(input: SourceSearchInput): Promise<SourceSearchResult>;
  readSource?(input: SourceReadInput): Promise<SourceReadResult>;
  listPages(
    input?: PageListInput,
    options?: { allowedPageSlugs?: ReadonlySet<string> },
  ): Promise<PageListResult>;
  /** Query 专用：列出可见 Subject 摘要，不改变 active Subject。 */
  listSubjects?(): Promise<SubjectToolListResult>;
  /** Query 专用：在显式指定的其他 Subject 中检索。 */
  searchCrossSubject?(input: CrossSubjectSearchInput): Promise<CrossSubjectSearchResult>;
  /** Query 专用：读取显式指定的其他 Subject 页面正文。 */
  readCrossSubjectPage?(input: CrossSubjectReadInput): Promise<CrossSubjectReadResult>;
  /** Query 专用：读取 active Subject 的 operation 时间线。 */
  listHistory?(input: HistoryListInput): Promise<HistoryListResult>;
  /** Query 专用：读取 active Subject 的单次 operation diff。 */
  readHistoryDiff?(input: HistoryDiffInput): Promise<HistoryDiffResult>;
  /** Query 专用：读取 active Subject job 的脱敏状态。 */
  readWorkflowStatus?(jobId: string): Promise<WorkflowStatusResult>;
  /** query 累积访问页用于引用核查；ingest 不传。 */
  onAccess?(page: { subjectSlug?: string; slug: string; title: string; body?: string }): void;
  /** 只记录来源标识，禁止把来源正文写入访问收集器。 */
  onSourceAccess?(access: { sourceId: string; chunkId?: string }): void;
  /** 可选 job 事件（ingest 经 agentCtx.emit）；query 不传（工具活动由流式响应携带）。 */
  emit?(type: string, message: string, data?: Record<string, unknown>): void;
  /** query 侧同步删除一页（Saga）；ingest 不传 → 工具在 ingest 中调用会优雅报错。 */
  deletePage?(slug: string): Promise<{ deletedSlug: string; brokenBacklinks: number }>;
  /** query 侧同步新建一页（Saga）；ingest 不传。 */
  createPage?(input: { title: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ createdSlug: string }>;
  /** curate 侧合并两页（Saga）；仅 worker curate runner 注入。 */
  mergePages?(targetSlug: string, sourceSlug: string):
    Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }>;
  /** curate 侧拆分一页（Saga）；仅 worker curate runner 注入。 */
  splitPage?(slug: string, hint?: string):
    Promise<{ primarySlug: string; pageSlugs: string[]; referencesRepointed: number }>;
  /** 更新一页（可选改标题+正文，Saga）；fix runner 与 query runner 均注入。 */
  updatePage?(input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ updatedSlug: string; referencesUpdated: number }>;
  /** 局部更新一页正文（edits 精确唯一替换，Saga）；fix runner 与 query runner 均注入。 */
  patchPage?(input: { slug: string; edits: Array<{ oldString: string; newString: string }> }):
    Promise<{ updatedSlug: string; appliedEdits: number }>;
  /** Fix/Curate 侧元数据窄写；只改 title/summary/tags/aliases，不接收正文。 */
  metadataPatch?(input: MetadataPatchInput): Promise<MetadataPatchResult>;
  /** Fix/Curate 侧单链接窄写；target 仅验证，唯一写对象是 source page。 */
  linkEnsure?(input: LinkEnsureInput): Promise<LinkEnsureResult>;
  /** query 侧只读联网检索（Tavily）；工具集只在 web search 已配置时才含 web.search，未配置时不会被调用。 */
  webSearch?(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
  /** ingest / re-enrich 的 enricher 专用生图能力；图片会暂存到当前 changeset。 */
  generateImage?(input: ImageGenerateInput): Promise<ImageGenerateOutput>;
}

/** 从 AgentContext 构造流水线 ToolContext：读/搜走 overlay，生图仅在传入可信当前页时注入。 */
export function agentToolContext(agentCtx: AgentContext, currentPageSlug?: string): ToolContext {
  const subjectSlug = agentCtx.subject.slug;
  const evidence = createSubjectEvidenceReader(agentCtx.subject);
  const context: ToolContext = {
    subject: agentCtx.subject,
    async readPage(slug) {
      const res = await agentCtx.overlay.readPage(subjectSlug, slug);
      if (!res) return null;
      const title = parseFrontmatter(res.markdown).data.title || slug;
      return { title, markdown: res.markdown };
    },
    async search(query, limit) {
      const hits = await agentCtx.overlay.search(subjectSlug, query);
      return hits.slice(0, limit).map((h) => ({ slug: h.slug, title: h.title, summary: h.summary }));
    },
    async listPages(input, options) {
      return evidence.listPages(input, options);
    },
    emit: (type, message, data) => agentCtx.emit(type, message, data),
  };
  if (currentPageSlug) {
    context.generateImage = async (input) => {
      const { output, asset } = await generateImageAsset(input, subjectSlug, (usage) => {
        agentCtx.budget?.chargeTokens((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
      });
      const assetEntry = {
        action: 'create' as const,
        path: asset.path,
        content: asset.content,
        contentEncoding: 'base64' as const,
        auxiliary: true as const,
        auxiliaryKind: 'asset' as const,
        assetFor: currentPageSlug,
      };
      const existing = agentCtx.pending.entries.findIndex((entry) => entry.path === assetEntry.path);
      if (existing >= 0) agentCtx.pending.entries[existing] = assetEntry;
      else agentCtx.pending.entries.push(assetEntry);
      return output;
    };
  }
  return context;
}
