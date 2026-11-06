import { SfxEvent } from './sfx-types';

export const DENSITY = {
  minimal: { perMin: 3, minConf: 0.75, minGap: 2.0 },
  balanced: { perMin: 8, minConf: 0.55, minGap: 1.0 },
  heavy: { perMin: 16, minConf: 0.4, minGap: 0.6 },
} as const;

export type DensityLevel = keyof typeof DENSITY;

export function applyDensity(
  candidates: SfxEvent[],
  duration: number,
  density: DensityLevel
): SfxEvent[] {
  const { perMin, minConf, minGap } = DENSITY[density];
  const budget = Math.max(1, Math.round((duration / 60) * perMin));
  const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const kept: SfxEvent[] = [];

  for (const e of ranked) {
    if (kept.length >= budget) break;
    if (e.confidence < minConf) continue;
    if (kept.some((k) => Math.abs(k.time - e.time) < minGap)) continue;
    kept.push(e);
  }

  return kept.sort((a, b) => a.time - b.time);
}
