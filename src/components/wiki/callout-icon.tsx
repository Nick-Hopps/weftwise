import React from 'react';
import {
  BookOpen,
  CircleHelp,
  Image,
  Info,
  Layers3,
  Lightbulb,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

const CALLOUT_ICONS: Record<string, LucideIcon> = {
  intuition: Lightbulb,
  example: BookOpen,
  quiz: CircleHelp,
  background: Layers3,
  diagram: Image,
  pitfall: TriangleAlert,
};

export function CalloutIcon({ type }: { type: string }) {
  const Icon = CALLOUT_ICONS[type] ?? Info;
  return (
    <span className="callout-icon" data-callout-icon={type} aria-hidden="true">
      <Icon focusable="false" />
    </span>
  );
}
