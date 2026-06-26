import { z } from 'zod';

export const READING_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const VERBOSITY_LEVELS = ['terse', 'balanced', 'thorough'] as const;
export const EXAMPLE_DENSITIES = ['few', 'some', 'many'] as const;
export const FORMALITIES = ['casual', 'neutral', 'formal'] as const;

export const StylePrefsSchema = z.object({
  readingLevel: z.enum(READING_LEVELS),
  verbosity: z.enum(VERBOSITY_LEVELS),
  exampleDensity: z.enum(EXAMPLE_DENSITIES),
  formality: z.enum(FORMALITIES),
});

export type StylePrefs = z.infer<typeof StylePrefsSchema>;

// 编译期守卫：本模块（zod 真源）与 contracts.ts（client 纯类型）的 StylePrefs
// 必须双向结构等价；任一处枚举漂移都会在此报类型错误。
type _AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _styleMatchesContract: _AssertExact<StylePrefs, import('@/lib/contracts').StylePrefs> = true;
void _styleMatchesContract;

export const DEFAULT_STYLE_PREFS: StylePrefs = {
  readingLevel: 'intermediate',
  verbosity: 'balanced',
  exampleDensity: 'some',
  formality: 'neutral',
};

/** 在有序档位数组内移动 delta 档，越界钳制；未知值原样返回。 */
export function stepLevel<T extends string>(levels: readonly T[], current: T, delta: number): T {
  const i = levels.indexOf(current);
  if (i < 0) return current;
  const next = Math.max(0, Math.min(levels.length - 1, i + delta));
  return levels[next];
}
