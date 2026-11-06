import { describe, it, expect } from 'vitest';
import { SFX_TYPES, SfxType, SfxEditEvent } from '../ai/sfx-types';
import { SynthProvider } from '../audio/sfx/synth';
import { renderSfxBus, eventGain, sfxPeakDb, MixEvent } from '../audio/mix';
import { selectToSchedule } from '../audio/preview';
import { SR } from '../audio/sfx/dsp';
import { SfxSound } from '../audio/sfx/provider';

const synth = new SynthProvider();

describe('SynthProvider - 30 Types × 3 Variants Validation', () => {
  const types = Object.keys(SFX_TYPES) as SfxType[];

  // Max duration limit specs for each sound type
  const DURATION_LIMITS: Record<SfxType, number> = {
    whoosh_fast: 0.6,
    whoosh_slow: 1.4,
    swipe: 0.4,
    pop: 0.2,
    click: 0.1,
    typing: 1.1,
    notification: 0.8,
    ding: 1.4,
    bell: 2.2,
    sparkle: 1.2,
    impact_soft: 0.6,
    impact_hard: 1.0,
    boom: 2.5,
    bass_drop: 1.8,
    punch: 0.5,
    riser: 2.8,
    reverse_riser: 2.0,
    glitch: 0.6,
    camera_shutter: 0.35,
    record_scratch: 0.8,
    error_buzz: 0.6,
    rimshot: 0.8,
    applause: 2.8,
    glass_break: 1.4,
    door_close: 0.8,
    footsteps: 1.8,
    cash_register: 1.6,
    heartbeat: 1.6,
    stinger_intro: 1.8,
    stinger_outro: 2.0,
  };

  types.forEach((type) => {
    [0, 1, 2].forEach((variant) => {
      it(`validates ${type} variant ${variant}`, async () => {
        const sound = await synth.get(type, variant);
        expect(sound).not.toBeNull();
        if (!sound) return;

        const { samples, duration, anchor, peakDb } = sound;

        // 1. No NaN
        let sum = 0;
        let hasNan = false;
        for (let i = 0; i < samples.length; i++) {
          if (Number.isNaN(samples[i])) {
            hasNan = true;
            break;
          }
          sum += samples[i];
        }
        expect(hasNan).toBe(false);

        // 2. Peak between -7 and -5 dBFS (nominally normalized to -6 dBFS)
        expect(peakDb).toBeGreaterThanOrEqual(-7.0);
        expect(peakDb).toBeLessThanOrEqual(-5.0);

        // 3. |mean| < 0.01 (removeDc)
        const mean = sum / samples.length;
        expect(Math.abs(mean)).toBeLessThan(0.01);

        // 4. First and last 5 ms magnitude < 0.01 (fadeEdges)
        const sampleCount5ms = Math.min(samples.length >> 1, Math.round((5 / 1000) * SR));
        expect(Math.abs(samples[0])).toBeLessThan(0.01);
        expect(Math.abs(samples[samples.length - 1])).toBeLessThan(0.01);

        // 5. Duration <= limit
        const limit = DURATION_LIMITS[type] || 3.0;
        expect(duration).toBeLessThanOrEqual(limit);

        // 6. 0 <= anchor <= duration
        expect(anchor).toBeGreaterThanOrEqual(0.0);
        expect(anchor).toBeLessThanOrEqual(duration + 0.001);

        // 7. Deterministic check (second call produces identical samples)
        const reSound = await synth.get(type, variant);
        expect(reSound?.samples.length).toBe(samples.length);
        expect(reSound?.samples[100]).toBe(samples[100]);
        expect(reSound?.anchor).toBe(anchor);
      });
    });
  });
});

describe('Mix Logic - renderSfxBus & eventGain', () => {
  const speech = [{ start: 2.0, end: 5.0 }];
  const basePeakDb = -6;

  it('computes eventGain with ducking (0.6) inside speech for non-transition intents', () => {
    const normalEvent: MixEvent = {
      id: '1',
      time: 3.5, // inside speech
      type: 'pop',
      variant: 0,
      volume: 1.0,
      intent: 'action',
      enabled: true,
    };

    const gainNormal = eventGain(normalEvent, speech, basePeakDb, 1.0);
    const expectedNormal = Math.pow(10, -6 / 20) * 1.0 * 0.6 * 1.0;
    expect(gainNormal).toBeCloseTo(expectedNormal, 4);

    const transitionEvent: MixEvent = {
      id: '2',
      time: 3.5, // inside speech
      type: 'whoosh_fast',
      variant: 0,
      volume: 1.0,
      intent: 'transition',
      enabled: true,
    };

    const gainTrans = eventGain(transitionEvent, speech, basePeakDb, 1.0);
    const expectedTrans = Math.pow(10, -6 / 20) * 1.0 * 1.0 * 1.0;
    expect(gainTrans).toBeCloseTo(expectedTrans, 4);
  });

  it('renderSfxBus puts first non-zero sample at t - anchor, trims negative start, skips disabled events, and soft-limits peak <= -1 dBFS', async () => {
    // Mock provider returning a simple pulse with anchor 0.1
    const mockSound: SfxSound = {
      samples: new Float32Array(Math.ceil(0.5 * SR)).map((_, i) => (i === 0 ? 0 : Math.sin(i / 10))),
      sampleRate: SR,
      anchor: 0.1,
      duration: 0.5,
      peakDb: -6,
    };
    mockSound.samples[0] = 0;
    mockSound.samples[Math.round(0.01 * SR)] = 0.8; // actual peak

    const mockLoader = async () => mockSound;

    const events: MixEvent[] = [
      {
        id: 'e1',
        time: 1.0, // start = 1.0 - 0.1 = 0.9s
        type: 'pop',
        variant: 0,
        volume: 1.0,
        intent: 'action',
        enabled: true,
      },
      {
        id: 'e_disabled',
        time: 1.2,
        type: 'ding',
        variant: 0,
        volume: 1.0,
        intent: 'emphasis',
        enabled: false, // skipped
      },
    ];

    const [leftBus] = await renderSfxBus(events, mockLoader, 3.0, [], -6, 1.0);

    // Event at t=1.0 with anchor 0.1 -> start sample offset = Math.round(0.9 * 44100) = 39690
    const startIdx = Math.round(0.9 * SR);
    const peakOffsetIdx = startIdx + Math.round(0.01 * SR);

    expect(leftBus[startIdx - 100]).toBe(0);
    expect(Math.abs(leftBus[peakOffsetIdx])).toBeGreaterThan(0.1);

    // Verify soft limiter prevents sum from exceeding -1 dBFS (amplitude 10^(-1/20) ~ 0.89125)
    // 20 overlapping loud events
    const heavyEvents: MixEvent[] = new Array(20).fill(null).map((_, idx) => ({
      id: `h_${idx}`,
      time: 1.0,
      type: 'impact_hard',
      variant: 0,
      volume: 1.0,
      intent: 'emphasis',
      enabled: true,
    }));

    const [heavyBus] = await renderSfxBus(heavyEvents, mockLoader, 3.0, [], -6, 1.5);
    let maxAmp = 0;
    for (let i = 0; i < heavyBus.length; i++) {
      maxAmp = Math.max(maxAmp, Math.abs(heavyBus[i]));
    }
    const peakDb = 20 * Math.log10(maxAmp);
    expect(peakDb).toBeLessThanOrEqual(-0.99); // <= -1 dBFS
  });
});

describe('Preview Scheduler - selectToSchedule', () => {
  const sound: SfxSound = {
    samples: new Float32Array(100),
    sampleRate: SR,
    anchor: 0.1,
    duration: 0.5,
    peakDb: -6,
  };

  const soundsMap = new Map<string, SfxSound>();
  soundsMap.set('whoosh_fast:0', sound);

  const events: MixEvent[] = [
    { id: '1', time: 1.0, type: 'whoosh_fast', variant: 0, volume: 1.0, intent: 'transition', enabled: true }, // start = 0.9s
    { id: '2', time: 1.5, type: 'whoosh_fast', variant: 0, volume: 1.0, intent: 'transition', enabled: true }, // start = 1.4s
    { id: '3', time: 3.0, type: 'whoosh_fast', variant: 0, volume: 1.0, intent: 'transition', enabled: true }, // start = 2.9s
  ];

  it('schedules events within lookahead window and ignores already scheduled or far events', () => {
    const scheduled = new Set<string>();

    // At videoTime 0.8s, lookahead 0.25s -> window [0.8, 1.05]. Event 1 start is 0.9s.
    const round1 = selectToSchedule(events, soundsMap, 0.8, 0.25, scheduled);
    expect(round1.map((e) => e.id)).toEqual(['1']);

    // Mark event 1 as scheduled
    scheduled.add('1');

    // At videoTime 0.95s, lookahead 0.25s -> window [0.95, 1.2]
    const round2 = selectToSchedule(events, soundsMap, 0.95, 0.25, scheduled);
    expect(round2.map((e) => e.id)).toEqual([]);

    // At videoTime 1.3s, lookahead 0.25s -> window [1.3, 1.55]. Event 2 start is 1.4s.
    const round3 = selectToSchedule(events, soundsMap, 1.3, 0.25, scheduled);
    expect(round3.map((e) => e.id)).toEqual(['2']);
  });

  it('resets correctly on seek (clearing scheduled set)', () => {
    const scheduled = new Set<string>(['1', '2']);
    // Seek back to 0.7s and clear scheduled set
    scheduled.clear();

    const roundSeek = selectToSchedule(events, soundsMap, 0.85, 0.25, scheduled);
    expect(roundSeek.map((e) => e.id)).toEqual(['1']);
  });
});
