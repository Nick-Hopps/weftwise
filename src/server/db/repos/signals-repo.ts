import { desc, eq } from 'drizzle-orm';
import { getDb } from '../client';
import { profileSignals } from '../schema';
import type { SignalType } from '@/server/profile/signal-reducer';

export function appendSignal(sig: {
  userId: string;
  type: SignalType;
  subjectId?: string | null;
  slug?: string | null;
}): void {
  getDb()
    .insert(profileSignals)
    .values({
      userId: sig.userId,
      type: sig.type,
      subjectId: sig.subjectId ?? null,
      slug: sig.slug ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** 最近 limit 条信号（id DESC），供 reducer 评估。 */
export function recentSignals(userId: string, limit: number): { type: SignalType }[] {
  return getDb()
    .select({ type: profileSignals.type })
    .from(profileSignals)
    .where(eq(profileSignals.userId, userId))
    .orderBy(desc(profileSignals.id))
    .limit(limit)
    .all()
    .map((r) => ({ type: r.type as SignalType }));
}
