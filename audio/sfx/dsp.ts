export const SR = 44100;

export function rng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s >>>= 0;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export const buf = (sec: number) => new Float32Array(Math.max(1, Math.ceil(sec * SR)));

export function noise(n: number, r: () => number) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = r() * 2 - 1;
  return o;
}

// freq may be a number or a per-sample function (for sweeps). Phase-accumulated oscillator.
export function osc(
  n: number,
  freq: number | ((i: number) => number),
  shape: 'sine' | 'saw' | 'square' | 'tri' = 'sine'
) {
  const o = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = typeof freq === 'number' ? freq : freq(i);
    ph += f / SR;
    ph -= Math.floor(ph);
    o[i] =
      shape === 'sine'
        ? Math.sin(2 * Math.PI * ph)
        : shape === 'saw'
        ? 2 * ph - 1
        : shape === 'square'
        ? ph < 0.5
          ? 1
          : -1
        : 1 - 4 * Math.abs(ph - 0.5);
  }
  return o;
}

// RBJ biquad; f may be per-sample (coefficients refreshed every 32 samples)
export function biquad(
  x: Float32Array,
  type: 'lp' | 'hp' | 'bp',
  f: number | ((i: number) => number),
  q = 0.707
) {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0,
    b0 = 0,
    b1 = 0,
    b2 = 0,
    a1 = 0,
    a2 = 0;
  for (let i = 0; i < x.length; i++) {
    if ((i & 31) === 0) {
      const fc = Math.min(SR * 0.45, Math.max(10, typeof f === 'number' ? f : f(i)));
      const w = (2 * Math.PI * fc) / SR,
        c = Math.cos(w),
        al = Math.sin(w) / (2 * q),
        a0 = 1 + al;
      if (type === 'lp') {
        b0 = (1 - c) / 2;
        b1 = 1 - c;
        b2 = (1 - c) / 2;
      } else if (type === 'hp') {
        b0 = (1 + c) / 2;
        b1 = -(1 + c);
        b2 = (1 + c) / 2;
      } else {
        b0 = al;
        b1 = 0;
        b2 = -al;
      }
      a1 = (-2 * c) / a0;
      a2 = (1 - al) / a0;
      b0 /= a0;
      b1 /= a0;
      b2 /= a0;
    }
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

export const expEnv = (n: number, tau: number, attack = 0.002) => {
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    e[i] = (t < attack ? t / attack : 1) * Math.exp(-t / tau);
  }
  return e;
};

export const mul = (a: Float32Array, b: Float32Array) => {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] * (b[i] ?? 0);
  return o;
};

export function addInto(dst: Float32Array, src: Float32Array, atSec: number, gain = 1) {
  const off = Math.round(atSec * SR);
  for (let i = 0; i < src.length && off + i < dst.length; i++) {
    if (off + i >= 0) dst[off + i] += src[i] * gain;
  }
}

export function fadeEdges(x: Float32Array, ms = 4) {
  const n = Math.min(x.length >> 1, Math.round((ms / 1000) * SR));
  if (n <= 0) return x;
  for (let i = 0; i < n; i++) {
    const g = i / n;
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

export function normalizePeak(x: Float32Array, peakDb = -6) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) {
    const g = Math.pow(10, peakDb / 20) / m;
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  return x;
}

export function peakDbOf(x: Float32Array) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m > 0 ? 20 * Math.log10(m) : -120;
}

export function removeDc(x: Float32Array) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  const avg = sum / x.length;
  for (let i = 0; i < x.length; i++) x[i] -= avg;
  return x;
}
