import { SfxType, SfxIntent } from '@/ai/sfx-types';
import { SfxSound } from './sfx/provider';
import { SR } from './sfx/dsp';

export interface MixEvent {
  id: string;
  time: number;
  type: SfxType;
  variant: number;
  volume: number; // 0..1
  intent: SfxIntent;
  enabled: boolean;
}

export function sfxPeakDb(envelopeDb: number[] | null): number {
  if (!envelopeDb || envelopeDb.length === 0) return -9;
  const s = [...envelopeDb].sort((a, b) => a - b);
  const p90 = s[Math.floor(s.length * 0.9)];
  return Math.min(-3, Math.max(-24, p90 + 4)); // SFX peak relative to the loud parts of the video
}

export function eventGain(
  e: MixEvent,
  speech: { start: number; end: number }[],
  basePeakDb: number,
  master: number
): number {
  const inSpeech = speech.some((s) => e.time >= s.start && e.time <= s.end);
  const duck = inSpeech && !['transition', 'intro', 'outro'].includes(e.intent) ? 0.6 : 1;
  return Math.pow(10, basePeakDb / 20) * Math.min(1, Math.max(0, e.volume)) * duck * master;
}

/**
 * Pure mixdown: returns stereo (identical L/R) Float32Arrays of the SFX bus at 44100 Hz,
 * soft-limited so the sum never exceeds -1 dBFS.
 */
export async function renderSfxBus(
  events: MixEvent[],
  sounds: (e: MixEvent) => Promise<SfxSound>,
  duration: number,
  speech: { start: number; end: number }[],
  basePeakDb: number,
  master: number
): Promise<[Float32Array, Float32Array]> {
  const busLength = Math.max(1, Math.ceil(duration * SR));
  const bus = new Float32Array(busLength);

  const enabledEvents = events.filter((e) => e.enabled);
  const normBase = Math.pow(10, -6 / 20); // pre-normalized peak amplitude

  for (const e of enabledEvents) {
    const sound = await sounds(e);
    if (!sound || !sound.samples) continue;

    const gain = eventGain(e, speech, basePeakDb, master);
    const scale = gain / normBase;
    const startSample = Math.round((e.time - sound.anchor) * SR);

    for (let i = 0; i < sound.samples.length; i++) {
      const idx = startSample + i;
      if (idx >= 0 && idx < busLength) {
        bus[idx] += sound.samples[i] * scale;
      }
    }
  }

  // Apply soft limiter: y = threshold * tanh(x / threshold) with threshold = 10^(-1/20)
  const threshold = Math.pow(10, -1 / 20);
  const left = new Float32Array(busLength);
  const right = new Float32Array(busLength);

  for (let i = 0; i < busLength; i++) {
    const val = bus[i];
    const limited = threshold * Math.tanh(val / threshold);
    left[i] = limited;
    right[i] = limited;
  }

  return [left, right];
}
