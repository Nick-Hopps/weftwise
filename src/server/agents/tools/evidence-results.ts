import type { WikiInspection } from '@/lib/contracts';

/** inspect 不存在页与 scope 外页共享同一空结果，避免侧信道差异。 */
export function emptyWikiInspection(): WikiInspection {
  return {
    found: false,
    page: null,
    outgoing: [],
    backlinks: [],
    sources: [],
    health: {
      brokenLinks: 0,
      inboundCount: 0,
      outboundCount: 0,
      sourceCount: 0,
    },
  };
}
