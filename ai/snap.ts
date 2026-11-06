import { SfxEvent, SpeechSegment } from './sfx-types';

/**
 * Snaps candidate events to nearest scene cuts or transient audio spikes.
 */
export function snapEvents(
  events: SfxEvent[],
  cuts: number[],
  transients: number[],
  duration: number
): SfxEvent[] {
  const minTime = 0.05;
  const maxTime = Math.max(minTime, duration - 0.2);

  const nearest = (arr: number[], t: number, win: number) => {
    let best: number | null = null;
    let bd = win;
    for (const x of arr) {
      const d = Math.abs(x - t);
      if (d <= bd) {
        bd = d;
        best = x;
      }
    }
    return best;
  };

  return events.map((e) => {
    let t = Math.min(Math.max(e.time, minTime), maxTime);
    let snapped: SfxEvent['snapped'] = 'none';

    const tryCut = (w: number) => {
      const c = nearest(cuts, t, w);
      if (c !== null) {
        t = c;
        snapped = 'cut';
      }
    };

    const tryTr = (w: number) => {
      const x = nearest(transients, t, w);
      if (x !== null) {
        t = x;
        snapped = 'transient';
      }
    };

    if (e.intent === 'transition') {
      tryCut(0.35);
    } else if (['emphasis', 'action', 'comedy', 'emotion'].includes(e.intent)) {
      tryTr(0.25);
      if (snapped === 'none') {
        tryCut(0.25);
      }
    } else if (e.intent === 'text_on_screen') {
      tryCut(0.3);
    }

    let confidence = e.confidence;
    if (snapped === 'none' && ['transition', 'emphasis'].includes(e.intent)) {
      confidence *= 0.7;
    }

    return {
      ...e,
      time: Number(t.toFixed(3)),
      snapped,
      confidence: Number(confidence.toFixed(3)),
    };
  });
}

/**
 * Post-processes candidate events:
 * 1. Remove events inside speech segments unless intent is transition/intro/outro or type is impact_hard/boom
 * 2. Remove same type within 4s (keep higher confidence)
 * 3. Remove any two events closer than 0.6s (keep higher confidence)
 * 4. Drop events with confidence < 0.3
 */
export function finalizeCandidates(
  events: SfxEvent[],
  speech: SpeechSegment[],
  duration: number
): SfxEvent[] {
  // 1. Drop low confidence early (< 0.3)
  let list = events.filter((e) => e.confidence >= 0.3);

  // 2. Remove events inside speech segments
  list = list.filter((e) => {
    const isExempt =
      ['transition', 'intro', 'outro'].includes(e.intent) ||
      e.type === 'impact_hard' ||
      e.type === 'boom';
    if (isExempt) return true;

    // Inside speech if event.time is between speech start and end
    const inSpeech = speech.some((seg) => e.time >= seg.start && e.time <= seg.end);
    return !inSpeech;
  });

  // Sort by confidence descending to prioritize higher confidence when resolving conflicts
  list.sort((a, b) => b.confidence - a.confidence);

  // 3. Remove same type within 4 seconds (keeping higher confidence because list is sorted by conf desc)
  const keptTypes: SfxEvent[] = [];
  for (const e of list) {
    const conflict = keptTypes.some(
      (k) => k.type === e.type && Math.abs(k.time - e.time) < 4.0
    );
    if (!conflict) {
      keptTypes.push(e);
    }
  }

  // 4. Remove any two events closer than 0.6s (keeping higher confidence)
  const keptProximity: SfxEvent[] = [];
  for (const e of keptTypes) {
    const conflict = keptProximity.some((k) => Math.abs(k.time - e.time) < 0.6);
    if (!conflict) {
      keptProximity.push(e);
    }
  }

  // Sort by time ascending for chronological order
  return keptProximity.sort((a, b) => a.time - b.time);
}
