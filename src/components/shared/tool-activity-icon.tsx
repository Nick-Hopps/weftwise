import React from 'react';
import {
  Activity,
  Bot,
  CircleCheck,
  CircleDot,
  CirclePlay,
  Compass,
  FileDiff,
  FilePenLine,
  FilePlus2,
  FileText,
  Files,
  FolderTree,
  Globe2,
  Image,
  Import,
  LibraryBig,
  Link2,
  Merge,
  MoveRight,
  ScanSearch,
  Search,
  Sparkles,
  Split,
  Square,
  Tags,
  Telescope,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { toolActivityIcon, type ToolActivityIconName } from '@/lib/tool-activity';

const TOOL_ACTIVITY_ICONS: Record<ToolActivityIconName, LucideIcon> = {
  activity: Activity,
  bot: Bot,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  'circle-play': CirclePlay,
  compass: Compass,
  'file-diff': FileDiff,
  'file-pen': FilePenLine,
  'file-plus': FilePlus2,
  'file-text': FileText,
  files: Files,
  'folder-tree': FolderTree,
  globe: Globe2,
  image: Image,
  import: Import,
  library: LibraryBig,
  link: Link2,
  merge: Merge,
  'move-right': MoveRight,
  'scan-search': ScanSearch,
  search: Search,
  sparkles: Sparkles,
  split: Split,
  stop: Square,
  tags: Tags,
  telescope: Telescope,
  trash: Trash2,
  wrench: Wrench,
};

/** 按语义图标键渲染。日志时间线的工具行与阶段行共用它，保证同一套图标语言。 */
export function SemanticIcon({ name, className = 'h-3.5 w-3.5' }: {
  name: ToolActivityIconName;
  className?: string;
}) {
  const Icon = TOOL_ACTIVITY_ICONS[name];
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      className={className}
      data-tool-icon={name}
    />
  );
}

export function ToolActivityIcon({ tool, className = 'h-3.5 w-3.5' }: {
  tool: string;
  className?: string;
}) {
  return <SemanticIcon name={toolActivityIcon(tool)} className={className} />;
}
