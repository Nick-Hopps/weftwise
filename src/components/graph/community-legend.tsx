'use client';

/**
 * CommunityLegend — floating legend showing community colors,
 * node type shapes, and edge type styles.
 */

interface CommunityLegendProps {
  communities: number[];
  darkMode: boolean;
  getCommunityColor: (id: number, darkMode?: boolean) => string;
  nodeCount: number;
  edgeCount: number;
}

const NODE_TYPES: Array<{ kind: string; label: string; shape: string; isTriangle?: boolean; isDiamond?: boolean }> = [
  { kind: 'wiki-page', label: 'Page', shape: 'rounded-full' },
  { kind: 'function', label: 'Function', shape: '', isTriangle: true },
  { kind: 'class', label: 'Class', shape: '', isDiamond: true },
  { kind: 'concept', label: 'Concept', shape: 'rounded-sm' },
];

const EDGE_TYPES = [
  { kind: 'EXTRACTED', label: 'Extracted', style: 'border-solid' },
  { kind: 'INFERRED', label: 'Inferred', style: 'border-dashed' },
  { kind: 'AMBIGUOUS', label: 'Ambiguous', style: 'border-dotted border-rose-400' },
];

export function CommunityLegend({
  communities,
  darkMode,
  getCommunityColor,
  nodeCount,
  edgeCount,
}: CommunityLegendProps) {
  // Show at most 10 communities in the legend
  const displayCommunities = communities.slice(0, 10);

  return (
    <div className="absolute bottom-3 left-3 max-w-[280px] bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400 shadow-sm border border-zinc-200 dark:border-zinc-700">
      {/* Stats */}
      <div className="flex items-center gap-3 mb-2 pb-1.5 border-b border-zinc-200 dark:border-zinc-700">
        <span>{nodeCount} nodes</span>
        <span>{edgeCount} edges</span>
        <span>{communities.length} communities</span>
      </div>

      {/* Communities */}
      {displayCommunities.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {displayCommunities.map((cid) => (
            <span key={cid} className="flex items-center gap-1">
              <span
                className="w-2.5 h-2.5 rounded-full inline-block"
                style={{ backgroundColor: getCommunityColor(cid, darkMode) }}
              />
              <span className="text-[10px]">C{cid}</span>
            </span>
          ))}
          {communities.length > 10 && (
            <span className="text-[10px] text-zinc-400">+{communities.length - 10} more</span>
          )}
        </div>
      )}

      {/* Node types */}
      <div className="flex flex-wrap gap-2 mb-1.5">
        {NODE_TYPES.map((t) => (
          <span key={t.kind} className="flex items-center gap-1">
            {t.isTriangle ? (
              <span className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[7px] border-transparent border-b-zinc-400 dark:border-b-zinc-500 inline-block" />
            ) : t.isDiamond ? (
              <span className="w-2 h-2 bg-zinc-400 dark:bg-zinc-500 inline-block rotate-45" />
            ) : (
              <span className={`w-2 h-2 bg-zinc-400 dark:bg-zinc-500 inline-block ${t.shape}`} />
            )}
            <span className="text-[10px]">{t.label}</span>
          </span>
        ))}
      </div>

      {/* Edge types */}
      <div className="flex flex-wrap gap-2">
        {EDGE_TYPES.map((t) => (
          <span key={t.kind} className="flex items-center gap-1">
            <span className={`w-4 h-0 border-t-2 ${t.style} border-indigo-400 inline-block`} />
            <span className="text-[10px]">{t.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
