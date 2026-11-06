import { describe, it, expect } from 'vitest';
import { detectCuts, detectTransients, detectQuietGaps } from '../analysis/detect';
import { encodeWav16k } from '../analysis/wav';

describe('detectCuts', () => {
  it('detects a single scene cut from a flat signal with one step change', () => {
    // 25 frames, flat baseline difference ~0.01 with a sharp spike at t=1.2s (index 12)
    const diffs: { t: number; d: number }[] = [];
    for (let i = 0; i < 25; i++) {
      diffs.push({
        t: Number((i * 0.1).toFixed(2)),
        d: i === 12 ? 0.65 : 0.01,
      });
    }

    const cuts = detectCuts(diffs);
    expect(cuts.length).toBe(1);
    expect(cuts[0].t).toBe(1.2);
    expect(cuts[0].strength).toBe(0.65);
  });

  it('returns empty array when there are no significant frame differences', () => {
    const diffs: { t: number; d: number }[] = [];
    for (let i = 0; i < 20; i++) {
      diffs.push({ t: i * 0.1, d: 0.02 });
    }
    const cuts = detectCuts(diffs);
    expect(cuts.length).toBe(0);
  });
});

describe('detectTransients', () => {
  it('detects a transient from a quiet signal with a sharp click', () => {
    const hz = 50;
    // 50 samples (1 second) of quiet noise at -65 dBFS, with a sharp spike at index 30 to -15 dBFS
    const env: number[] = new Array(50).fill(-65);
    env[30] = -15;

    const transients = detectTransients(env, hz);
    expect(transients.length).toBe(1);
    expect(transients[0].t).toBeCloseTo(30 / hz, 2);
    expect(transients[0].strengthDb).toBeGreaterThanOrEqual(9);
  });

  it('returns empty array when signal has no sudden rises', () => {
    const env = new Array(60).fill(-50);
    const transients = detectTransients(env, 50);
    expect(transients.length).toBe(0);
  });
});

describe('detectQuietGaps', () => {
  it('detects 1 second of silence in the middle of active audio', () => {
    const hz = 50;
    // 0.5s active (-20 dBFS = 25 samples)
    // 1.0s silence (-85 dBFS = 50 samples)
    // 0.5s active (-20 dBFS = 25 samples)
    const env: number[] = [
      ...new Array(25).fill(-20),
      ...new Array(50).fill(-85),
      ...new Array(25).fill(-20),
    ];

    const gaps = detectQuietGaps(env, hz, 0.35);
    expect(gaps.length).toBe(1);
    expect(gaps[0].start).toBeCloseTo(0.5, 2);
    expect(gaps[0].end).toBeCloseTo(1.5, 2);
    expect(gaps[0].end - gaps[0].start).toBeCloseTo(1.0, 2);
  });

  it('ignores quiet gaps shorter than minSec', () => {
    const hz = 50;
    // Gap of 0.2s (10 samples) when minSec is 0.35s
    const env: number[] = [
      ...new Array(30).fill(-20),
      ...new Array(10).fill(-85),
      ...new Array(30).fill(-20),
    ];
    const gaps = detectQuietGaps(env, hz, 0.35);
    expect(gaps.length).toBe(0);
  });
});

describe('encodeWav16k', () => {
  it('produces valid 16-bit PCM WAV with correct header fields and length = 44 + samples * 2', async () => {
    const numSamples = 200;
    const samples = new Float32Array(numSamples);
    // Fill with a simple sine wave
    for (let i = 0; i < numSamples; i++) {
      samples[i] = Math.sin((i / numSamples) * Math.PI * 2);
    }

    const blob = encodeWav16k(samples, 16000);
    const expectedLength = 44 + numSamples * 2;
    expect(blob.size).toBe(expectedLength);

    const arrayBuffer = await blob.arrayBuffer();
    const view = new DataView(arrayBuffer);

    // Read string helper
    const readString = (offset: number, length: number) => {
      let str = '';
      for (let i = 0; i < length; i++) {
        str += String.fromCharCode(view.getUint8(offset + i));
      }
      return str;
    };

    // Header assertions
    expect(readString(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(expectedLength - 8);
    expect(readString(8, 4)).toBe('WAVE');
    expect(readString(12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // Subchunk1Size
    expect(view.getUint16(20, true)).toBe(1);  // AudioFormat (PCM = 1)
    expect(view.getUint16(22, true)).toBe(1);  // NumChannels (mono = 1)
    expect(view.getUint32(24, true)).toBe(16000); // SampleRate
    expect(view.getUint32(28, true)).toBe(32000); // ByteRate (16000 * 1 * 2)
    expect(view.getUint16(32, true)).toBe(2);  // BlockAlign
    expect(view.getUint16(34, true)).toBe(16); // BitsPerSample
    expect(readString(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(numSamples * 2);
  });
});
