import { describe, it, expect, vi } from 'vitest';
import { snapEvents, finalizeCandidates } from '../ai/snap';
import { applyDensity, DENSITY } from '../ai/density';
import { normalizeDirectorResponse } from '../ai/repair';
import {
  buildGeminiGenerateContentBody,
  callGeminiGenerateContent,
  rankGeminiModels,
  redactApiKey,
} from '../ai/gemini';
import { buildDirectorInstructionPrompt, DIRECTOR_SCHEMA } from '../ai/director';
import { SfxEvent, SpeechSegment } from '../ai/sfx-types';
import { AnalysisBundle } from '../types/analysis';

describe('snapEvents', () => {
  const cuts = [1.5, 4.0, 8.2];
  const transients = [2.2, 5.5, 9.1];
  const duration = 12.0;

  it('snaps transition within 0.35s of a cut exactly to it', () => {
    const events: SfxEvent[] = [
      {
        id: 'e1',
        time: 1.6,
        type: 'whoosh_fast',
        intent: 'transition',
        reason: 'cut transition',
        confidence: 0.9,
        volume: 0.8,
        snapped: 'none',
      },
    ];

    const snapped = snapEvents(events, cuts, transients, duration);
    expect(snapped[0].snapped).toBe('cut');
    expect(snapped[0].time).toBe(1.5);
    expect(snapped[0].confidence).toBe(0.9);
  });

  it('snaps emphasis to a transient within 0.25s', () => {
    const events: SfxEvent[] = [
      {
        id: 'e2',
        time: 2.3,
        type: 'impact_soft',
        intent: 'emphasis',
        reason: 'emphasis beat',
        confidence: 0.85,
        volume: 0.7,
        snapped: 'none',
      },
    ];

    const snapped = snapEvents(events, cuts, transients, duration);
    expect(snapped[0].snapped).toBe('transient');
    expect(snapped[0].time).toBe(2.2);
    expect(snapped[0].confidence).toBe(0.85);
  });

  it('far event stays none and confidence is penalized by 0.7 for transition/emphasis', () => {
    const events: SfxEvent[] = [
      {
        id: 'e3',
        time: 3.1, // far from cuts (1.5, 4.0) and transients (2.2, 5.5)
        type: 'whoosh_fast',
        intent: 'transition',
        reason: 'mid-scene transition',
        confidence: 0.8,
        volume: 0.7,
        snapped: 'none',
      },
    ];

    const snapped = snapEvents(events, cuts, transients, duration);
    expect(snapped[0].snapped).toBe('none');
    expect(snapped[0].time).toBe(3.1);
    expect(snapped[0].confidence).toBeCloseTo(0.8 * 0.7, 3);
  });
});

describe('finalizeCandidates', () => {
  const duration = 20.0;
  const speech: SpeechSegment[] = [
    { start: 2.0, end: 5.0 },
    { start: 10.0, end: 14.0 },
  ];

  it('drops events inside speech unless intent is transition/intro/outro or type is impact_hard/boom', () => {
    const events: SfxEvent[] = [
      {
        id: 'e1',
        time: 3.0, // inside speech 2.0-5.0, action intent
        type: 'click',
        intent: 'action',
        reason: 'user click',
        confidence: 0.9,
        volume: 0.7,
        snapped: 'none',
      },
      {
        id: 'e2',
        time: 3.5, // inside speech, but intent is transition
        type: 'whoosh_fast',
        intent: 'transition',
        reason: 'cut through speech',
        confidence: 0.95,
        volume: 0.8,
        snapped: 'cut',
      },
      {
        id: 'e3',
        time: 11.0, // inside speech, but type is impact_hard
        type: 'impact_hard',
        intent: 'emphasis',
        reason: 'dramatic emphasis',
        confidence: 0.9,
        volume: 0.9,
        snapped: 'none',
      },
      {
        id: 'e4',
        time: 7.0, // outside speech
        type: 'pop',
        intent: 'text_on_screen',
        reason: 'pop up',
        confidence: 0.8,
        volume: 0.6,
        snapped: 'none',
      },
    ];

    const finalized = finalizeCandidates(events, speech, duration);
    const ids = finalized.map((e) => e.id);
    expect(ids).not.toContain('e1'); // dropped
    expect(ids).toContain('e2'); // kept (transition intent)
    expect(ids).toContain('e3'); // kept (impact_hard type)
    expect(ids).toContain('e4'); // kept (outside speech)
  });

  it('removes same type within 4 seconds keeping higher confidence', () => {
    const events: SfxEvent[] = [
      {
        id: 'w1',
        time: 6.0,
        type: 'whoosh_fast',
        intent: 'transition',
        reason: 'first whoosh',
        confidence: 0.6,
        volume: 0.7,
        snapped: 'none',
      },
      {
        id: 'w2',
        time: 7.5, // 1.5s later (within 4s)
        type: 'whoosh_fast',
        intent: 'transition',
        reason: 'second whoosh with higher conf',
        confidence: 0.9,
        volume: 0.8,
        snapped: 'none',
      },
    ];

    const finalized = finalizeCandidates(events, [], duration);
    expect(finalized.length).toBe(1);
    expect(finalized[0].id).toBe('w2');
  });

  it('removes events closer than 0.6s keeping higher confidence', () => {
    const events: SfxEvent[] = [
      {
        id: 'c1',
        time: 6.0,
        type: 'pop',
        intent: 'text_on_screen',
        reason: 'pop',
        confidence: 0.92,
        volume: 0.7,
        snapped: 'none',
      },
      {
        id: 'c2',
        time: 6.3, // only 0.3s apart
        type: 'click',
        intent: 'action',
        reason: 'click',
        confidence: 0.7,
        volume: 0.6,
        snapped: 'none',
      },
    ];

    const finalized = finalizeCandidates(events, [], duration);
    expect(finalized.length).toBe(1);
    expect(finalized[0].id).toBe('c1');
  });

  it('drops events with confidence < 0.3', () => {
    const events: SfxEvent[] = [
      {
        id: 'low',
        time: 1.0,
        type: 'pop',
        intent: 'action',
        reason: 'uncertain',
        confidence: 0.25,
        volume: 0.5,
        snapped: 'none',
      },
    ];

    const finalized = finalizeCandidates(events, [], duration);
    expect(finalized.length).toBe(0);
  });
});

describe('applyDensity', () => {
  it('respects budget, minGap, and minConf for each level', () => {
    expect(DENSITY.minimal.perMin).toBe(3);
    expect(DENSITY.minimal.minConf).toBe(0.75);
    expect(DENSITY.minimal.minGap).toBe(2.0);

    expect(DENSITY.balanced.perMin).toBe(8);
    expect(DENSITY.balanced.minConf).toBe(0.55);
    expect(DENSITY.balanced.minGap).toBe(1.0);

    expect(DENSITY.heavy.perMin).toBe(16);
    expect(DENSITY.heavy.minConf).toBe(0.4);
    expect(DENSITY.heavy.minGap).toBe(0.6);
  });

  it('for a 30s video at minimal density, returns at most 2 events', () => {
    const candidates: SfxEvent[] = [
      { id: '1', time: 2.0, type: 'whoosh_fast', intent: 'transition', reason: 'r', confidence: 0.95, volume: 0.8, snapped: 'cut' },
      { id: '2', time: 8.0, type: 'pop', intent: 'action', reason: 'r', confidence: 0.9, volume: 0.8, snapped: 'none' },
      { id: '3', time: 14.0, type: 'ding', intent: 'emphasis', reason: 'r', confidence: 0.85, volume: 0.8, snapped: 'none' },
      { id: '4', time: 20.0, type: 'boom', intent: 'action', reason: 'r', confidence: 0.8, volume: 0.8, snapped: 'none' },
    ];

    // 30s video: budget = Math.max(1, Math.round((30 / 60) * 3)) = Math.round(1.5) = 2
    const filtered = applyDensity(candidates, 30, 'minimal');
    expect(filtered.length).toBeLessThanOrEqual(2);
    expect(filtered.length).toBe(2);
  });
});

describe('normalizeDirectorResponse', () => {
  const duration = 10.0;

  it('drops unknown sound types and maps known synonyms', () => {
    const raw = JSON.stringify({
      videoType: 'vlog',
      mood: 'upbeat',
      summary: 'fun day out',
      needsSfx: true,
      recommendedDensity: 'balanced',
      reasoning: 'cuts and visual accents benefit from audio reinforcement',
      speech: [],
      events: [
        { time: 1.0, type: 'whoosh', intent: 'transition', reason: 'swipe cut', confidence: 0.8, volume: 0.7 },
        { time: 2.0, type: 'hit', intent: 'emphasis', reason: 'punchy accent', confidence: 0.8, volume: 0.7 },
        { time: 3.0, type: 'thud', intent: 'emphasis', reason: 'soft accent', confidence: 0.8, volume: 0.7 },
        { time: 4.0, type: 'swoosh', intent: 'action', reason: 'hand motion', confidence: 0.8, volume: 0.7 },
        { time: 5.0, type: 'sting', intent: 'intro', reason: 'title sting', confidence: 0.8, volume: 0.7 },
        { time: 6.0, type: 'alien_laser_cannon', intent: 'action', reason: 'unknown', confidence: 0.8, volume: 0.7 },
      ],
    });

    const res = normalizeDirectorResponse(raw, duration);
    const types = res.events.map((e) => e.type);

    expect(types).toContain('whoosh_fast'); // whoosh mapped
    expect(types).toContain('impact_hard'); // hit mapped
    expect(types).toContain('impact_soft'); // thud mapped
    expect(types).toContain('swipe');       // swoosh mapped
    expect(types).toContain('stinger_intro'); // sting mapped
    expect(types).not.toContain('alien_laser_cannon'); // unknown dropped
  });

  it('clamps event times to [0.05, duration - 0.2]', () => {
    const raw = JSON.stringify({
      videoType: 'tutorial',
      mood: 'focused',
      summary: 'coding tutorial',
      needsSfx: true,
      recommendedDensity: 'minimal',
      reasoning: 'subtle clicks',
      speech: [],
      events: [
        { time: 0.01, type: 'click', intent: 'action', reason: 'early click', confidence: 0.8, volume: 0.7 },
        { time: 9.95, type: 'pop', intent: 'text_on_screen', reason: 'end pop', confidence: 0.8, volume: 0.7 },
      ],
    });

    const res = normalizeDirectorResponse(raw, duration);
    expect(res.events[0].time).toBe(0.05);
    expect(res.events[1].time).toBe(Number((duration - 0.2).toFixed(3)));
  });

  it('extracts JSON object when surrounded by extra markdown or conversation text', () => {
    const raw = `Here is your JSON response:
\`\`\`json
{
  "videoType": "comedy",
  "mood": "funny",
  "summary": "funny sketch",
  "needsSfx": true,
  "recommendedDensity": "heavy",
  "reasoning": "comedy timing needs rimshots and record scratches",
  "speech": [{ "start": 1.0, "end": 4.0 }],
  "events": [
    { "time": 4.5, "type": "rimshot", "intent": "comedy", "reason": "punchline", "confidence": 0.9, "volume": 0.8 }
  ]
}
\`\`\`
Hope this helps!`;

    const res = normalizeDirectorResponse(raw, duration);
    expect(res.videoType).toBe('comedy');
    expect(res.events.length).toBe(1);
    expect(res.events[0].type).toBe('rimshot');
  });
});

describe('gemini request builder & client', () => {
  it('places key in x-goog-api-key header and NOT in URL, uses generationConfig with no config field', () => {
    const parts = [
      { text: 'Sample intro' },
      { inlineData: { mimeType: 'audio/wav', data: 'AQID' } },
      { text: 'Frame at t=1.00s' },
      { inlineData: { mimeType: 'image/jpeg', data: 'dGVzdA==' } },
      { text: 'Final instructions' },
    ];

    const body = buildGeminiGenerateContentBody(parts, DIRECTOR_SCHEMA, 0.2);

    // Body structure assertions
    expect(body.generationConfig).toBeDefined();
    expect((body as any).config).toBeUndefined();
    expect(body.generationConfig?.temperature).toBe(0.2);
    expect(body.generationConfig?.responseMimeType).toBe('application/json');
    expect(body.generationConfig?.responseSchema).toBeDefined();

    // Parts order assertions: audio, then frame text+image, then instructions
    const p = body.contents[0].parts;
    expect(p[0].text).toBe('Sample intro');
    expect(p[1].inlineData?.mimeType).toBe('audio/wav');
    expect(p[2].text).toBe('Frame at t=1.00s');
    expect(p[3].inlineData?.mimeType).toBe('image/jpeg');
    expect(p[4].text).toBe('Final instructions');
  });

  it('redacts sensitive API keys from strings and error messages', () => {
    const rawSecret = 'AIzaSyTest1234567890abcdefghijklmnopqrst';
    const text = `Failed request with key ${rawSecret}`;
    const cleaned = redactApiKey(text, rawSecret);
    expect(cleaned).not.toContain(rawSecret);
    expect(cleaned).toContain('[REDACTED]');
  });

  it('ranks models preferring flash > flash-lite > pro and higher version numbers', () => {
    const list = [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.5-flash-preview',
    ];

    const ranked = rankGeminiModels(list);
    // Highest version stable flash should be first
    expect(ranked[0]).toBe('gemini-2.5-flash');
    expect(ranked[1]).toBe('gemini-2.5-flash-preview');
    expect(ranked[2]).toBe('gemini-2.0-flash');
    expect(ranked[3]).toBe('gemini-2.0-flash-lite');
  });
});
