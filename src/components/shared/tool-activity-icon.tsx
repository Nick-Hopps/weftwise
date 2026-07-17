import React from 'react';
import {
  Activity,
  Compass,
  FileDiff,
  FilePenLine,
  FilePlus2,
  FileText,
  Files,
  Globe2,
  Image,
  LibraryBig,
  Link2,
  Merge,
  MoveRight,
  Search,
  Sparkles,
  Split,
  Square,
  Tags,
  Telescope,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { toolActivityIcon, type ToolActivityIconName } from '@/lib/tool-activity';

const TOOL_ACTIVITY_ICONS: Record<ToolActivityIconName, LucideIcon> = {
  activity: Activity,
  compass: Compass,
  'file-diff': FileDiff,
  'file-pen': FilePenLine,
  'file-plus': FilePlus2,
  'file-text': FileText,
  files: Files,
  globe: Globe2,
  image: Image,
  library: LibraryBig,
  link: Link2,
  merge: Merge,
  'move-right': MoveRight,
  search: Search,
  sparkles: Sparkles,
  split: Split,
  stop: Square,
  tags: Tags,
  telescope: Telescope,
  trash: Trash2,
};

export function ToolActivityIcon({ tool, className = 'h-3.5 w-3.5' }: {
  tool: string;
  className?: string;
}) {
  const iconName = toolActivityIcon(tool);
  const Icon = TOOL_ACTIVITY_ICONS[iconName];
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      className={className}
      data-tool-icon={iconName}
    />
  );
}
