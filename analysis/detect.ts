/**
 * Pure signal detection functions for video cuts, audio transients, and quiet gaps.
 */

export function detectCuts(diffs: { t: number; d: number }[]): { t: number; strength: number }[] {
  const out: { t: number; strength: number }[] = [];
  for (let i = 1; i < diffs.length; i++) {
    const lo = Math.max(0, i - 5);
    const hi = Math.min(diffs.length - 1, i + 5);
    const nb: number[] = [];
    for (let j = lo; j <= hi; j++) {
      if (j !== i) nb.push(diffs[j].d);
    }
    nb.sort((a, b) => a - b);
    const med = nb.length ? nb[Math.floor(nb.length / 2)] : 0;
    const score = diffs[i].d / (med + 0.02);
    if (diffs[i].d > 0.15 && score > 3) {
      const last = out[out.length - 1];
      if (!last || diffs[i].t - last.t >= 0.3) {
        out.push({ t: diffs[i].t, strength: Math.min(1, diffs[i].d) });
      } else if (diffs[i].d > last.strength) {
        out[out.length - 1] = { t: diffs[i].t, strength: Math.min(1, diffs[i].d) };
      }
    }
  }
  return out;
}

export function detectTransients(env: number[], hz = 50): { t: number; strengthDb: number }[] {
  const out: { t: number; strengthDb: number }[] = [];
  for (let i = 4; i < env.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 30); j <= i - 3; j++) {
      sum += env[j];
      n++;
    }
    const avg = n ? sum / n : env[i];
    const rise = env[i] - avg;
    if (rise >= 9 && env[i] > -45 && env[i] >= env[i - 1]) {
      const t = i / hz;
      const last = out[out.length - 1];
      if (!last || t - last.t >= 0.15) {
        out.push({ t, strengthDb: rise });
      } else if (rise > last.strengthDb) {
        out[out.length - 1] = { t, strengthDb: rise };
      }
    }
  }
  return out;
}

export function detectQuietGaps(env: number[], hz = 50, minSec = 0.35): { start: number; end: number }[] {
  const sorted = [...env].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -100;
  const thr = Math.max(floor + 6, -60);
  const gaps: { start: number; end: number }[] = [];
  let s = -1;
  for (let i = 0; i <= env.length; i++) {
    const quiet = i < env.length && env[i] < thr;
    if (quiet && s < 0) s = i;
    if (!quiet && s >= 0) {
      if ((i - s) / hz >= minSec) {
        gaps.push({ start: s / hz, end: i / hz });
      }
      s = -1;
    }
  }
  return gaps;
}
