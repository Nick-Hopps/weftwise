import type { Subject } from '@/lib/contracts';
import { tool } from 'ai';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Image, Node, Parent, Root } from 'mdast';
import { streamTextResponse, streamTextWithTools } from '@/server/llm/provider-registry';
import { getWikiLanguage } from '@/server/db/repos/settings-repo';
import {
  generateImageAsset,
  ImageGenerateInputSchema,
  type ImageGenerateInput,
} from '@/server/agents/tools/builtin/image-generate';
import type { StylePrefs } from '@/server/profile/style';
import {
  RESHAPE_PAGE_SYSTEM_PROMPT,
  RESHAPE_SECTION_SYSTEM_PROMPT,
  buildReshapePageUserPrompt,
  buildReshapeSectionUserPrompt,
} from '@/server/llm/prompts/reshape-prompt';
import type { PromptContext } from '@/server/llm/prompts/prompt-context';

type ProfileLite = { backgroundSummary: string; stylePrefs: StylePrefs };

function ctxFor(subject: Subject): PromptContext {
  return {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };
}

export interface ReshapeAsset {
  id: string;
  mediaType: string;
  dataBase64: string;
}

const RENDITION_ASSET_PREFIX = '/api/rendition-assets/';

function isParent(node: Node): node is Parent {
  return 'children' in node && Array.isArray((node as Parent).children);
}

function isImage(node: Node): node is Image {
  return node.type === 'image';
}

function renditionAssetIds(markdown: string): Set<string> {
  const root = unified().use(remarkParse).parse(markdown) as Root;
  const ids = new Set<string>();
  const visit = (node: Node) => {
    if (isImage(node) && node.url.startsWith(RENDITION_ASSET_PREFIX)) {
      const id = node.url.slice(RENDITION_ASSET_PREFIX.length);
      if (id && !id.includes('/') && !id.includes('?') && !id.includes('#')) ids.add(id);
    }
    if (isParent(node)) node.children.forEach(visit);
  };
  visit(root);
  return ids;
}

function referencedAssets(markdown: string, generated: ReshapeAsset[]): ReshapeAsset[] {
  const referencedIds = renditionAssetIds(markdown);
  const generatedIds = new Set(generated.map((asset) => asset.id));
  for (const id of referencedIds) {
    if (!generatedIds.has(id)) {
      throw new Error(`Reshape referenced unknown rendition asset "${id}"`);
    }
  }
  return generated.filter((asset) => referencedIds.has(asset.id));
}

/** 用文本流收全文成字符串（本服务对外是 JSON 响应，不流式）。 */
async function collect(
  task: 'reshape:page' | 'reshape:section',
  system: string,
  user: string,
  subjectId: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = streamTextResponse(task, system, user, signal, {}, subjectId);
  let out = '';
  for await (const chunk of res.textStream) out += chunk;
  return out.trim();
}

function assetIdFromPath(path: string): string {
  const filename = path.split('/').at(-1) ?? '';
  return filename.replace(/\.[^.]+$/, '');
}

/** 整页自由重塑；图片先暂存在返回值，由路由与 Markdown 一起原子持久化。 */
export async function reshapePageBody(input: {
  subject: Subject;
  body: string;
  profile: ProfileLite;
  abortSignal?: AbortSignal;
}): Promise<{ body: string; model: string | null; assets: ReshapeAsset[] }> {
  const ctx = ctxFor(input.subject);
  const user = buildReshapePageUserPrompt(input.body, input.profile, ctx);
  const assets: ReshapeAsset[] = [];
  const imageGenerate = tool({
    description: 'Generate one explanatory image and return the URL to embed in the reshaped Markdown.',
    inputSchema: ImageGenerateInputSchema,
    execute: async (imageInput: ImageGenerateInput) => {
      const generated = await generateImageAsset(
        imageInput,
        input.subject.slug,
        undefined,
        input.abortSignal,
        input.subject.id,
      );
      const id = assetIdFromPath(generated.asset.path);
      assets.push({ id, mediaType: generated.asset.mediaType, dataBase64: generated.asset.content });
      return { ...generated.output, path: id, url: `/api/rendition-assets/${id}` };
    },
  });
  const response = streamTextWithTools('reshape:page', {
    system: RESHAPE_PAGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    tools: { image_generate: imageGenerate },
    maxSteps: 4,
    abortSignal: input.abortSignal,
    usageSubjectId: input.subject.id,
  });
  let body = '';
  for await (const chunk of response.textStream) body += chunk;
  body = body.trim();
  if (!body) throw new Error('Reshape produced empty Markdown');
  return { body, model: null, assets: referencedAssets(body, assets) };
}

/** 段级自由重塑。 */
export async function reshapeSection(input: {
  subject: Subject;
  block: string;
  direction: 'simpler' | 'deeper';
  profile: ProfileLite;
  context?: string;
}): Promise<{ block: string; fallback: boolean }> {
  const ctx = ctxFor(input.subject);
  const user = buildReshapeSectionUserPrompt(input.block, input.direction, input.profile, ctx, input.context);
  const out = await collect(
    'reshape:section',
    RESHAPE_SECTION_SYSTEM_PROMPT,
    user,
    input.subject.id,
  );
  return { block: out, fallback: false };
}
