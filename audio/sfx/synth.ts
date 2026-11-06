import { SfxType } from '@/ai/sfx-types';
import { SfxSound, SfxProvider } from './provider';
import {
  SR,
  rng,
  buf,
  noise,
  osc,
  biquad,
  expEnv,
  mul,
  addInto,
  fadeEdges,
  normalizePeak,
  peakDbOf,
  removeDc,
} from './dsp';

function seedFor(type: SfxType, variant: number): number {
  let hash = 5381;
  const str = `${type}_v${variant}`;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

function processFinalSound(rawSamples: Float32Array, anchor: number): SfxSound {
  let samples = removeDc(rawSamples);
  samples = fadeEdges(samples, 6);
  samples = normalizePeak(samples, -6);

  const duration = Number((samples.length / SR).toFixed(3));
  const validAnchor = Math.min(Math.max(0, anchor), duration);
  const peakDb = Number(peakDbOf(samples).toFixed(2));

  return {
    samples,
    sampleRate: SR,
    anchor: Number(validAnchor.toFixed(3)),
    duration,
    peakDb,
  };
}

export class SynthProvider implements SfxProvider {
  async get(type: SfxType, variant: number): Promise<SfxSound | null> {
    const v = Math.max(0, Math.min(2, variant));
    const seed = seedFor(type, v);
    const r = rng(seed);

    switch (type) {
      case 'whoosh_fast': {
        const dur = 0.42 + v * 0.03;
        const n = Math.ceil(dur * SR);
        const x = biquad(noise(n, r), 'bp', (i) => 350 + 5200 * Math.pow(i / n, 2), 1.2 + v * 0.3);
        const env = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const p = i / n;
          env[i] =
            Math.pow(Math.sin((Math.PI * Math.min(1, p / 0.7)) / 2), 2) *
            (p < 0.7 ? 1 : Math.exp(-(p - 0.7) * 14));
        }
        return processFinalSound(mul(x, env), dur * 0.7);
      }

      case 'whoosh_slow': {
        const dur = 1.1 + v * 0.08;
        const n = Math.ceil(dur * SR);
        const x = biquad(noise(n, r), 'bp', (i) => 200 + 2800 * Math.pow(i / n, 1.8), 0.9 + v * 0.2);
        const env = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const p = i / n;
          env[i] =
            Math.pow(Math.sin((Math.PI * Math.min(1, p / 0.75)) / 2), 2) *
            (p < 0.75 ? 1 : Math.exp(-(p - 0.75) * 8));
        }
        return processFinalSound(mul(x, env), dur * 0.75);
      }

      case 'swipe': {
        const dur = 0.28 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const x = biquad(noise(n, r), 'bp', (i) => 600 + 1800 * Math.pow(i / n, 1.5), 2.5);
        const env = expEnv(n, 0.08 + v * 0.02, 0.04);
        return processFinalSound(mul(x, env), dur * 0.5);
      }

      case 'pop': {
        const dur = 0.11 + v * 0.01;
        const n = Math.ceil(dur * SR);
        const pitchDrop = (i: number) => 700 * Math.exp((-i / SR) * 35) + 180;
        const body = mul(osc(n, pitchDrop, 'sine'), expEnv(n, 0.025 + v * 0.005));
        const click = mul(biquad(noise(n, r), 'hp', 2500), expEnv(n, 0.004));
        const out = buf(dur);
        addInto(out, body, 0, 0.8);
        addInto(out, click, 0, 0.4);
        return processFinalSound(out, 0.005);
      }

      case 'click': {
        const dur = 0.045 + v * 0.005;
        const n = Math.ceil(dur * SR);
        const clickNoise = mul(biquad(noise(n, r), 'hp', 3000 + v * 500), expEnv(n, 0.006));
        const tone = mul(osc(n, 2400 + v * 200, 'sine'), expEnv(n, 0.003));
        const out = buf(dur);
        addInto(out, clickNoise, 0, 0.7);
        addInto(out, tone, 0, 0.3);
        return processFinalSound(out, 0.002);
      }

      case 'typing': {
        const dur = 0.85 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const numClicks = 6 + Math.floor(r() * 3);
        for (let c = 0; c < numClicks; c++) {
          const atSec = (c / numClicks) * 0.75 + r() * 0.04;
          const cn = Math.ceil(0.04 * SR);
          const rSeed = r();
          const clk = mul(
            biquad(noise(cn, () => rSeed * 2 - 1), 'hp', 2500 + rSeed * 1500),
            expEnv(cn, 0.008)
          );
          addInto(out, clk, atSec, 0.5 + r() * 0.5);
        }
        return processFinalSound(out, 0.002);
      }

      case 'notification': {
        const dur = 0.55 + v * 0.04;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const tone1 = mul(osc(n, 880 + v * 40, 'sine'), expEnv(n, 0.12));
        const tone2 = mul(osc(n, 1320 + v * 60, 'sine'), expEnv(n, 0.18));
        addInto(out, tone1, 0.0, 0.5);
        addInto(out, tone2, 0.08, 0.6);
        return processFinalSound(out, 0.0);
      }

      case 'ding': {
        const dur = 1.1 + v * 0.08;
        const n = Math.ceil(dur * SR);
        const f0 = 1568 + v * 100;
        const p1 = mul(osc(n, f0, 'sine'), expEnv(n, 0.25));
        const p2 = mul(osc(n, f0 * 2.01, 'sine'), expEnv(n, 0.15));
        const p3 = mul(osc(n, f0 * 3.02, 'sine'), expEnv(n, 0.08));
        const out = buf(dur);
        addInto(out, p1, 0, 0.6);
        addInto(out, p2, 0, 0.3);
        addInto(out, p3, 0, 0.15);
        return processFinalSound(out, 0.0);
      }

      case 'bell': {
        const dur = 1.9 + v * 0.1;
        const n = Math.ceil(dur * SR);
        const f0 = 800 + v * 80;
        const partials = [
          { ratio: 1.0, tau: 0.5, gain: 0.5 },
          { ratio: 2.76, tau: 0.35, gain: 0.3 },
          { ratio: 5.4, tau: 0.2, gain: 0.15 },
          { ratio: 8.9, tau: 0.1, gain: 0.08 },
        ];
        const out = buf(dur);
        for (const p of partials) {
          const component = mul(osc(n, f0 * p.ratio, 'sine'), expEnv(n, p.tau));
          addInto(out, component, 0, p.gain);
        }
        return processFinalSound(out, 0.0);
      }

      case 'sparkle': {
        const dur = 0.95 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const count = 10 + Math.floor(r() * 5);
        for (let i = 0; i < count; i++) {
          const atSec = (i / count) * 0.7 + r() * 0.05;
          const freq = 6500 - (i / count) * 4000 + r() * 600;
          const sn = Math.ceil(0.08 * SR);
          const blip = mul(osc(sn, freq, 'sine'), expEnv(sn, 0.015));
          addInto(out, blip, atSec, 0.3 + r() * 0.4);
        }
        return processFinalSound(out, 0.0);
      }

      case 'impact_soft': {
        const dur = 0.45 + v * 0.04;
        const n = Math.ceil(dur * SR);
        const pitch = (i: number) => 70 * Math.exp((-i / SR) * 20);
        const body = mul(osc(n, pitch, 'sine'), expEnv(n, 0.12));
        const click = mul(biquad(noise(n, r), 'lp', 1200), expEnv(n, 0.015));
        const out = buf(dur);
        addInto(out, body, 0, 0.8);
        addInto(out, click, 0, 0.3);
        return processFinalSound(out, 0.005);
      }

      case 'impact_hard': {
        const dur = 0.85 + v * 0.04;
        const n = Math.ceil(dur * SR);
        const body = mul(osc(n, (i) => 38 + 90 * Math.exp((-i / SR) * 28)), expEnv(n, 0.22 + v * 0.05));
        const click = mul(biquad(noise(n, r), 'lp', 3500), expEnv(n, 0.03));
        const out = buf(dur);
        addInto(out, body, 0, 1.0);
        addInto(out, click, 0, 0.6);
        return processFinalSound(out, 0.005);
      }

      case 'boom': {
        const dur = 2.1 + v * 0.09;
        const n = Math.ceil(dur * SR);
        const sub = mul(osc(n, (i) => 45 * Math.exp((-i / SR) * 3) + 22), expEnv(n, 0.6 + v * 0.1));
        const tail = mul(biquad(noise(n, r), 'lp', 300), expEnv(n, 0.4));
        const out = buf(dur);
        addInto(out, sub, 0, 0.8);
        addInto(out, tail, 0.01, 0.4);
        return processFinalSound(out, 0.02);
      }

      case 'bass_drop': {
        const dur = 1.55 + v * 0.04;
        const n = Math.ceil(dur * SR);
        const sweepFreq = (i: number) => {
          const t = i / SR;
          return t < 1.0 ? 120 - 90 * Math.pow(t, 0.7) : 30;
        };
        const rawOsc = osc(n, sweepFreq, 'sine');
        // tanh saturation
        const saturated = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          saturated[i] = Math.tanh(rawOsc[i] * 1.6);
        }
        const env = expEnv(n, 0.45);
        return processFinalSound(mul(saturated, env), 0.0);
      }

      case 'punch': {
        const dur = 0.38 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const thump = mul(osc(n, (i) => 130 * Math.exp((-i / SR) * 45)), expEnv(n, 0.08));
        const noiseBurst = mul(biquad(noise(n, r), 'lp', 800 + v * 100), expEnv(n, 0.04));
        const out = buf(dur);
        addInto(out, thump, 0, 0.7);
        addInto(out, noiseBurst, 0, 0.5);
        return processFinalSound(out, 0.005);
      }

      case 'riser': {
        const dur = 2.4 + v * 0.08;
        const n = Math.ceil(dur * SR);
        const freqSweep = (i: number) => 200 + 3800 * Math.pow(i / n, 2);
        const nSignal = biquad(noise(n, r), 'bp', freqSweep, 2.0);
        const sSignal = osc(n, freqSweep, 'saw');
        const env = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          env[i] = Math.pow(i / n, 2.2);
        }
        const out = buf(dur);
        for (let i = 0; i < n; i++) {
          out[i] = (nSignal[i] * 0.6 + sSignal[i] * 0.4) * env[i];
        }
        return processFinalSound(out, dur);
      }

      case 'reverse_riser': {
        const dur = 1.75 + v * 0.04;
        const n = Math.ceil(dur * SR);
        // Reversed noise swell
        const x = biquad(noise(n, r), 'hp', 1800);
        const env = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          env[i] = Math.pow(i / n, 2.5);
        }
        return processFinalSound(mul(x, env), dur);
      }

      case 'glitch': {
        const dur = 0.48 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const bursts = 5 + Math.floor(r() * 4);
        for (let b = 0; b < bursts; b++) {
          const atSec = (b / bursts) * 0.35;
          const bLen = Math.ceil((0.015 + r() * 0.025) * SR);
          const bNoise = noise(bLen, r);
          // Bit-crush / quantify noise
          for (let i = 0; i < bLen; i++) {
            bNoise[i] = Math.round(bNoise[i] * 4) / 4;
          }
          addInto(out, bNoise, atSec, 0.6);
        }
        return processFinalSound(out, 0.0);
      }

      case 'camera_shutter': {
        const dur = 0.24 + v * 0.01;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const click1 = mul(biquad(noise(Math.ceil(0.04 * SR), r), 'bp', 3200, 1.5), expEnv(Math.ceil(0.04 * SR), 0.008));
        const click2 = mul(biquad(noise(Math.ceil(0.04 * SR), r), 'bp', 2800, 1.5), expEnv(Math.ceil(0.04 * SR), 0.008));
        addInto(out, click1, 0, 0.8);
        addInto(out, click2, 0.06, 0.7);
        return processFinalSound(out, 0.0);
      }

      case 'record_scratch': {
        const dur = 0.68 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const oscFilter = (i: number) => {
          const p = i / n;
          return 800 + 1400 * Math.sin(p * Math.PI * 8) * Math.exp(-p * 2);
        };
        const x = biquad(noise(n, r), 'bp', oscFilter, 3.0);
        const env = expEnv(n, 0.25);
        return processFinalSound(mul(x, env), 0.0);
      }

      case 'error_buzz': {
        const dur = 0.48 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const sq = osc(n, 150 + v * 10, 'square');
        const saw = osc(n, 155 + v * 10, 'saw');
        const combined = new Float32Array(n);
        for (let i = 0; i < n; i++) combined[i] = (sq[i] + saw[i]) * 0.5;
        const filtered = biquad(combined, 'lp', 1200);
        const env = expEnv(n, 0.15);
        return processFinalSound(mul(filtered, env), 0.0);
      }

      case 'rimshot': {
        const dur = 0.68 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        // Kick at 0s
        const kickN = Math.ceil(0.12 * SR);
        const kick = mul(osc(kickN, (i) => 150 * Math.exp((-i / SR) * 35) + 50, 'sine'), expEnv(kickN, 0.04));
        addInto(out, kick, 0, 0.7);

        // Snare at 0.18s
        const snareN = Math.ceil(0.15 * SR);
        const snareBody = osc(snareN, 190, 'sine');
        const snareNoise = biquad(noise(snareN, r), 'bp', 1800, 1.2);
        const snare = mul(addArrays(snareBody, snareNoise), expEnv(snareN, 0.04));
        addInto(out, snare, 0.18, 0.8);

        // Cymbal hit at 0.34s (anchor)
        const cymN = Math.ceil(0.3 * SR);
        const cym = mul(biquad(noise(cymN, r), 'hp', 6000), expEnv(cymN, 0.1));
        addInto(out, cym, 0.34, 0.9);

        return processFinalSound(out, 0.34);
      }

      case 'applause': {
        const dur = 2.4 + v * 0.1;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const claps = 80;
        for (let c = 0; c < claps; c++) {
          const p = c / claps;
          const density = Math.sin(Math.PI * Math.min(1, p));
          if (r() < density * 0.9) {
            const atSec = (c / claps) * 2.2 + r() * 0.04;
            const clapN = Math.ceil(0.04 * SR);
            const clap = mul(biquad(noise(clapN, r), 'bp', 1200 + r() * 1000, 1.5), expEnv(clapN, 0.01));
            addInto(out, clap, atSec, 0.2 + r() * 0.3);
          }
        }
        return processFinalSound(out, 0.0);
      }

      case 'glass_break': {
        const dur = 1.15 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const mainBurstN = Math.ceil(0.08 * SR);
        const mainBurst = mul(biquad(noise(mainBurstN, r), 'hp', 3000), expEnv(mainBurstN, 0.02));
        addInto(out, mainBurst, 0, 0.8);

        const tinkles = 16;
        for (let t = 0; t < tinkles; t++) {
          const atSec = 0.02 + (t / tinkles) * 0.8 + r() * 0.05;
          const tn = Math.ceil(0.08 * SR);
          const freq = 4000 + r() * 6000;
          const tinkle = mul(osc(tn, freq, 'sine'), expEnv(tn, 0.015));
          addInto(out, tinkle, atSec, 0.15 + r() * 0.2);
        }
        return processFinalSound(out, 0.0);
      }

      case 'door_close': {
        const dur = 0.68 + v * 0.02;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const thud = mul(osc(n, (i) => 110 * Math.exp((-i / SR) * 25) + 35, 'sine'), expEnv(n, 0.15));
        const clickN = Math.ceil(0.05 * SR);
        const click = mul(biquad(noise(clickN, r), 'bp', 1400, 2.0), expEnv(clickN, 0.008));
        addInto(out, thud, 0, 0.8);
        addInto(out, click, 0, 0.5);
        return processFinalSound(out, 0.0);
      }

      case 'footsteps': {
        const dur = 1.55 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const stepSpacing = 0.38;
        for (let s = 0; s < 4; s++) {
          const atSec = s * stepSpacing;
          const stN = Math.ceil(0.12 * SR);
          const stepNoise = mul(biquad(noise(stN, r), 'lp', 160 + r() * 40), expEnv(stN, 0.03));
          addInto(out, stepNoise, atSec, 0.7);
        }
        return processFinalSound(out, 0.0);
      }

      case 'cash_register': {
        const dur = 1.35 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const mechN = Math.ceil(0.1 * SR);
        const mech = mul(biquad(noise(mechN, r), 'bp', 2200, 1.8), expEnv(mechN, 0.015));
        addInto(out, mech, 0, 0.7);

        const bellN = Math.ceil(0.8 * SR);
        const ding = mul(osc(bellN, 2400 + v * 100, 'sine'), expEnv(bellN, 0.25));
        addInto(out, ding, 0.12, 0.8);
        return processFinalSound(out, 0.0);
      }

      case 'heartbeat': {
        const dur = 1.35 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);
        const thump = (i: number) => 55 * Math.exp((-i / SR) * 30);
        const tLen = Math.ceil(0.15 * SR);
        const t1 = mul(osc(tLen, thump, 'sine'), expEnv(tLen, 0.05));
        const t2 = mul(osc(tLen, thump, 'sine'), expEnv(tLen, 0.04));

        addInto(out, t1, 0.0, 0.8);
        addInto(out, t2, 0.22, 0.6);
        addInto(out, t1, 0.7, 0.8);
        addInto(out, t2, 0.92, 0.6);
        return processFinalSound(out, 0.0);
      }

      case 'stinger_intro': {
        const dur = 1.48 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const chord1 = osc(n, 261.63, 'saw'); // C4
        const chord2 = osc(n, 329.63, 'saw'); // E4
        const chord3 = osc(n, 392.0, 'saw');  // G4
        const sumChord = new Float32Array(n);
        for (let i = 0; i < n; i++) sumChord[i] = (chord1[i] + chord2[i] + chord3[i]) / 3;
        const filteredChord = biquad(sumChord, 'lp', 2500);
        const chordEnv = expEnv(n, 0.4);

        const impact = mul(osc(n, (i) => 80 * Math.exp((-i / SR) * 20)), expEnv(n, 0.15));
        const reverbTail = mul(biquad(noise(n, r), 'lp', 1200), expEnv(n, 0.5, 0.05));

        const out = buf(dur);
        addInto(out, mul(filteredChord, chordEnv), 0, 0.6);
        addInto(out, impact, 0, 0.7);
        addInto(out, reverbTail, 0.05, 0.3);
        return processFinalSound(out, 0.0);
      }

      case 'stinger_outro': {
        const dur = 1.78 + v * 0.05;
        const n = Math.ceil(dur * SR);
        const out = buf(dur);

        // Note 1 at 0s
        const n1 = mul(osc(n, 440, 'sine'), expEnv(n, 0.18));
        addInto(out, n1, 0.0, 0.6);

        // Note 2 at 0.25s
        const n2 = mul(osc(n, 349.23, 'sine'), expEnv(n, 0.18));
        addInto(out, n2, 0.25, 0.6);

        // Final Chord at 0.5s (anchor)
        const c1 = osc(n, 261.63, 'saw');
        const c2 = osc(n, 329.63, 'saw');
        const chordSum = new Float32Array(n);
        for (let i = 0; i < n; i++) chordSum[i] = (c1[i] + c2[i]) * 0.5;
        const chordFiltered = biquad(chordSum, 'lp', 1800);
        const chordEnv = expEnv(n, 0.6);

        addInto(out, mul(chordFiltered, chordEnv), 0.5, 0.8);
        return processFinalSound(out, 0.5);
      }

      default:
        return null;
    }
  }
}

function addArrays(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] ?? 0);
  return o;
}
