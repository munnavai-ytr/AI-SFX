import { SFX_TYPES, SfxType, SFX_INTENTS, SfxIntent, SfxEvent, SpeechSegment } from './sfx-types';

export interface DirectorNormalizedResult {
  videoType: string;
  mood: string;
  summary: string;
  needsSfx: boolean;
  recommendedDensity: 'minimal' | 'balanced' | 'heavy';
  reasoning: string;
  speech: SpeechSegment[];
  events: SfxEvent[];
}

const SYNONYMS: Record<string, SfxType> = {
  whoosh: 'whoosh_fast',
  hit: 'impact_hard',
  thud: 'impact_soft',
  swoosh: 'swipe',
  sting: 'stinger_intro',
};

/**
 * Extracts the first balanced JSON object {...} substring from raw text.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.substring(start, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Pure function to parse, repair, validate, and normalize the Gemini AI Director response.
 */
export function normalizeDirectorResponse(raw: string, duration: number): DirectorNormalizedResult {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Director response was empty or not a string.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const extracted = extractFirstJsonObject(raw);
    if (!extracted) {
      throw new Error('No valid JSON object found in director response.');
    }
    try {
      parsed = JSON.parse(extracted);
    } catch (parseErr) {
      throw new Error(`Failed to parse extracted JSON from director response: ${(parseErr as Error).message}`);
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Director response JSON root must be an object.');
  }

  const videoType = typeof parsed.videoType === 'string' ? parsed.videoType.trim() : 'general';
  const mood = typeof parsed.mood === 'string' ? parsed.mood.trim() : 'neutral';
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const needsSfx = typeof parsed.needsSfx === 'boolean' ? parsed.needsSfx : true;

  let recommendedDensity: 'minimal' | 'balanced' | 'heavy' = 'balanced';
  if (parsed.recommendedDensity === 'minimal' || parsed.recommendedDensity === 'heavy') {
    recommendedDensity = parsed.recommendedDensity;
  }

  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '';

  // Parse speech segments
  const speech: SpeechSegment[] = [];
  if (Array.isArray(parsed.speech)) {
    for (const seg of parsed.speech) {
      if (typeof seg === 'object' && seg !== null) {
        const start = typeof seg.start === 'number' && !isNaN(seg.start) ? Math.max(0, seg.start) : 0;
        const end = typeof seg.end === 'number' && !isNaN(seg.end) ? Math.min(duration, seg.end) : start;
        if (end > start) {
          speech.push({
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
          });
        }
      }
    }
  }

  // Parse events
  const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
  const validEvents: SfxEvent[] = [];
  const minTime = 0.05;
  const maxTime = Math.max(minTime, duration - 0.2);

  const allowedTypes = new Set<string>(Object.keys(SFX_TYPES));
  const allowedIntents = new Set<string>(SFX_INTENTS);

  rawEvents.forEach((ev: any, idx: number) => {
    if (!ev || typeof ev !== 'object') return;

    let rawType = typeof ev.type === 'string' ? ev.type.trim().toLowerCase() : '';
    // Apply synonym mapping
    if (SYNONYMS[rawType]) {
      rawType = SYNONYMS[rawType];
    }

    if (!allowedTypes.has(rawType)) {
      // Drop events with unknown sound type
      return;
    }
    const type = rawType as SfxType;

    let intent: SfxIntent = 'emphasis';
    if (typeof ev.intent === 'string' && allowedIntents.has(ev.intent.trim().toLowerCase())) {
      intent = ev.intent.trim().toLowerCase() as SfxIntent;
    }

    const rawTime = typeof ev.time === 'number' && !isNaN(ev.time) ? ev.time : 0;
    const clampedTime = Math.min(maxTime, Math.max(minTime, rawTime));

    const rawConf = typeof ev.confidence === 'number' && !isNaN(ev.confidence) ? ev.confidence : 0.7;
    const confidence = Math.min(1, Math.max(0, rawConf));

    const rawVol = typeof ev.volume === 'number' && !isNaN(ev.volume) ? ev.volume : 0.7;
    const volume = Math.min(1, Math.max(0, rawVol));

    const reason = typeof ev.reason === 'string' ? ev.reason.trim() : 'AI selected sound effect';

    validEvents.push({
      id: `evt_${idx + 1}_${Math.round(clampedTime * 1000)}`,
      time: Number(clampedTime.toFixed(3)),
      type,
      intent,
      reason,
      confidence: Number(confidence.toFixed(3)),
      volume: Number(volume.toFixed(2)),
      snapped: 'none',
    });
  });

  // Sort by time ascending
  validEvents.sort((a, b) => a.time - b.time);

  return {
    videoType,
    mood,
    summary,
    needsSfx,
    recommendedDensity,
    reasoning,
    speech,
    events: validEvents,
  };
}
