import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { snapEvents, finalizeCandidates } from '../ai/snap';
import { applyDensity, DENSITY } from '../ai/density';
import { normalizeDirectorResponse } from '../ai/repair';
import {
  buildGeminiGenerateContentBody,
  callGeminiGenerateContent,
  rankGeminiModels,
  redactApiKey,
  getThinkingConfigForModel,
  isNoThinkingModel,
  markNoThinkingModel,
} from '../ai/gemini';
import { selectEquallySpacedSamples } from '../ai/director';
import { SfxEvent, SpeechSegment } from '../ai/sfx-types';

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
        time: 3.1,
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

  it('drops events inside speech unless intent is transition or type is impact_hard/boom', () => {
    const events: SfxEvent[] = [
      {
        id: 'e1',
        time: 3.0,
        type: 'click',
        intent: 'action',
        reason: 'user click',
        confidence: 0.9,
        volume: 0.7,
        snapped: 'none',
      },
      {
        id: 'e2',
        time: 3.5,
        type: 'whoosh_fast',
        intent: 'transition',
        reason: 'cut through speech',
        confidence: 0.95,
        volume: 0.8,
        snapped: 'cut',
      },
      {
        id: 'e3',
        time: 11.0,
        type: 'impact_hard',
        intent: 'emphasis',
        reason: 'dramatic emphasis',
        confidence: 0.9,
        volume: 0.9,
        snapped: 'none',
      },
      {
        id: 'e4',
        time: 7.0,
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
    expect(ids).not.toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).toContain('e3');
    expect(ids).toContain('e4');
  });
});

describe('rankGeminiModels', () => {
  it('ranks stable flash before preview flash, flash-lite before pro', () => {
    const list = [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.7-flash-preview',
    ];

    const ranked = rankGeminiModels(list);
    expect(ranked[0]).toBe('gemini-3.8-flash');
    expect(ranked[1]).toBe('gemini-2.0-flash');
    expect(ranked[2]).toBe('gemini-1.5-flash');
    expect(ranked[3]).toBe('gemini-3.7-flash-preview');
    expect(ranked[4]).toBe('gemini-3.1-flash-lite');
    expect(ranked[5]).toBe('gemini-1.5-pro');
  });
});

describe('thinkingConfig logic', () => {
  it('assigns thinkingBudget: 0 for 2.5 flash and thinkingLevel: LOW for gemini-3*', () => {
    const config25 = getThinkingConfigForModel('gemini-2.5-flash');
    expect(config25).toEqual({ thinkingBudget: 0 });

    const config38 = getThinkingConfigForModel('gemini-3.8-flash');
    expect(config38).toEqual({ thinkingLevel: 'LOW' });
  });

  it('omits thinkingConfig if model is marked in no-thinking-config', () => {
    markNoThinkingModel('models/gemini-3.7-flash');
    expect(isNoThinkingModel('models/gemini-3.7-flash')).toBe(true);

    const config = getThinkingConfigForModel('models/gemini-3.7-flash');
    expect(config).toBeUndefined();
  });
});

describe('sample frame downsampling', () => {
  it('selects at most 60 evenly spaced samples', () => {
    const dummySamples = Array.from({ length: 150 }, (_, i) => i);
    const selected = selectEquallySpacedSamples(dummySamples, 60);

    expect(selected.length).toBe(60);
    expect(selected[0]).toBe(0);
    expect(selected[selected.length - 1]).toBe(149);
  });
});

describe('callGeminiGenerateContent retry and timeout policies', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does NOT retry the same model on timeout and switches to next candidate model', async () => {
    let callCount = 0;
    const requestedEndpoints: string[] = [];

    global.fetch = vi.fn().mockImplementation((url, init) => {
      callCount++;
      requestedEndpoints.push(url.toString());

      if (callCount === 1) {
        return Promise.reject(new Error('timed out after 60 s'));
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: '{"events":[]}' }] } }],
        }),
      });
    });

    const body = buildGeminiGenerateContentBody([], {}, 0.2);
    const result = await callGeminiGenerateContent('fake-key', body);

    expect(result.text).toBe('{"events":[]}');
    expect(requestedEndpoints.length).toBe(2);
    expect(requestedEndpoints[0]).not.toBe(requestedEndpoints[1]);
  });

  it('retries HTTP 400 thinking error ONCE without thinkingConfig without counting as failure', async () => {
    const postBodies: any[] = [];

    global.fetch = vi.fn().mockImplementation((url, init) => {
      if (init?.body) {
        postBodies.push(JSON.parse(init.body));
      }

      if (postBodies.length === 1) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: { message: 'Invalid thinkingConfig setting' } }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: '{"events":[]}' }] } }],
        }),
      });
    });

    const body = buildGeminiGenerateContentBody([], {}, 0.2, 'gemini-3.8-flash');
    const result = await callGeminiGenerateContent('fake-key', body);

    expect(result.text).toBe('{"events":[]}');
    expect(postBodies.length).toBe(2);
    expect(postBodies[0].generationConfig?.thinkingConfig).toBeDefined();
    expect(postBodies[1].generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('stops immediately when total 150s deadline is exceeded', async () => {
    vi.useFakeTimers();

    global.fetch = vi.fn().mockImplementation(() => {
      // Fast forward fake timers past 150s
      vi.advanceTimersByTime(160000);
      return Promise.reject(new Error('timed out after 60 s'));
    });

    const body = buildGeminiGenerateContentBody([], {}, 0.2);
    const promise = callGeminiGenerateContent('fake-key', body);

    await expect(promise).rejects.toThrow('The AI did not answer in time. Check your connection, or try again.');

    vi.useRealTimers();
  });
});
