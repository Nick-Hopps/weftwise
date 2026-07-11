import { createToolRegistry } from '../registry';
import type { ToolRegistry, ToolDef } from '../../types';
import { wikiReadTool } from './wiki-read';
import { wikiSearchTool } from './wiki-search';
import { wikiListTool } from './wiki-list';
import { wikiReenrichTool } from './wiki-reenrich';
import { wikiDeleteTool } from './wiki-delete';
import { wikiCreateTool } from './wiki-create';
import { wikiUpdateTool } from './wiki-update';
import { wikiPatchTool } from './wiki-patch';
import { wikiMergeTool } from './wiki-merge';
import { wikiSplitTool } from './wiki-split';
import { webSearchTool } from './web-search';
import { wikiInspectTool } from './wiki-inspect';
import { sourceSearchTool } from './source-search';
import { sourceReadTool } from './source-read';
import { wikiPreviewChangeTool } from './wiki-preview-change';

/** 进程无关：worker 与 Next.js（query 流式）两进程各自构造（ToolDef 无状态纯对象）。 */
export function createBuiltinToolRegistry(): ToolRegistry {
  const r = createToolRegistry();
  r.register(wikiReadTool as ToolDef);
  r.register(wikiSearchTool as ToolDef);
  r.register(wikiListTool as ToolDef);
  r.register(wikiReenrichTool as ToolDef);
  r.register(wikiDeleteTool as ToolDef);
  r.register(wikiCreateTool as ToolDef);
  r.register(wikiUpdateTool as ToolDef);
  r.register(wikiPatchTool as ToolDef);
  r.register(wikiMergeTool as ToolDef);
  r.register(wikiSplitTool as ToolDef);
  r.register(webSearchTool as ToolDef);
  r.register(wikiInspectTool as ToolDef);
  r.register(sourceSearchTool as ToolDef);
  r.register(sourceReadTool as ToolDef);
  r.register(wikiPreviewChangeTool as ToolDef);
  return r;
}
