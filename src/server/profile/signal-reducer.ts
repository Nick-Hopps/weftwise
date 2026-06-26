import {
  StylePrefs, READING_LEVELS, VERBOSITY_LEVELS, EXAMPLE_DENSITIES, stepLevel,
} from './style';

export type SignalType =
  | 'too_hard' | 'too_easy' | 'simplify_click' | 'deepen_click' | 'view_original';

export interface ProfileSignal {
  type: SignalType;
}

export const SIGNAL_THRESHOLD = 2;

/**
 * 把近期信号聚合成对 StylePrefs 的一次有界微调。
 * simpler 方向：too_hard / simplify_click；deeper 方向：too_easy / deepen_click。
 * view_original 仅记录、不参与（可能是怀疑而非难度）。
 * 仅当净方向计数达到 SIGNAL_THRESHOLD 才动一档（防抖）。
 */
export function applySignalsToStyle(
  prefs: StylePrefs,
  recent: ProfileSignal[],
): { prefs: StylePrefs; changed: boolean } {
  let simpler = 0;
  let deeper = 0;
  for (const s of recent) {
    if (s.type === 'too_hard' || s.type === 'simplify_click') simpler++;
    else if (s.type === 'too_easy' || s.type === 'deepen_click') deeper++;
  }
  const net = simpler - deeper;
  if (Math.abs(net) < SIGNAL_THRESHOLD) return { prefs, changed: false };

  const wantsSimpler = net > 0;
  const next: StylePrefs = {
    ...prefs,
    readingLevel: stepLevel(READING_LEVELS, prefs.readingLevel, wantsSimpler ? -1 : +1),
    verbosity: stepLevel(VERBOSITY_LEVELS, prefs.verbosity, wantsSimpler ? +1 : -1),
    exampleDensity: wantsSimpler
      ? stepLevel(EXAMPLE_DENSITIES, prefs.exampleDensity, +1)
      : prefs.exampleDensity,
  };
  const changed = JSON.stringify(next) !== JSON.stringify(prefs);
  return { prefs: next, changed };
}
