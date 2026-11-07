/**
 * Pure scheduling, quota classification, and attempt planning logic for multi-key rotation.
 */

import { KeySlot, SlotId } from './keyvault';

export type CooldownReason = 'minute' | 'daily' | 'suspect' | 'server';

export interface CooldownEntry {
  until: number;
  reason: CooldownReason;
}

export type Failure =
  | { kind: 'minute'; cooldownMs: number }
  | { kind: 'daily'; cooldownMs: number }
  | { kind: 'invalid' }
  | { kind: 'suspect'; cooldownMs: number }
  | { kind: 'server'; cooldownMs: number }
  | { kind: 'client-error' }
  | { kind: 'network' };

const COOLDOWNS_STORAGE_KEY = 'sfx_ai_key_cooldowns_v1';

/**
 * Normalizes model names to format "models/gemini-..."
 */
export function normalizeModelName(model: string): string {
  if (!model) return 'models/gemini-3.8-flash';
  return model.startsWith('models/') ? model : `models/${model}`;
}

export function makeCooldownKey(slotId: SlotId, model: string): string {
  return `${slotId}|${normalizeModelName(model)}`;
}

/**
 * Loads stored cooldowns from localStorage, discarding expired ones.
 */
export function loadStoredCooldowns(): Map<string, CooldownEntry> {
  const map = new Map<string, CooldownEntry>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = localStorage.getItem(COOLDOWNS_STORAGE_KEY);
    if (!raw) return map;
    const obj: Record<string, CooldownEntry> = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.until > now) {
        map.set(k, v);
      }
    }
  } catch {}
  return map;
}

/**
 * Persists cooldowns to localStorage.
 */
export function saveStoredCooldowns(cooldowns: Map<string, CooldownEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    const obj: Record<string, CooldownEntry> = {};
    const now = Date.now();
    for (const [k, v] of cooldowns.entries()) {
      if (v.until > now) {
        obj[k] = v;
      }
    }
    localStorage.setItem(COOLDOWNS_STORAGE_KEY, JSON.stringify(obj));
  } catch {}
}

/**
 * Calculates next midnight America/Los_Angeles (Pacific Time) timestamp in ms.
 */
export function nextMidnightPacific(now: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const secs = (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second);
  return now + (86400 - secs) * 1000; // DST-edge days may be off by up to 1 h; acceptable
}

/**
 * Selects the next ready key slot for a model using Least-Recently-Used order.
 * Slots that are disabled, invalid, or currently cooling down for (slot, model) are skipped.
 */
export function pickKey(
  slots: KeySlot[],
  model: string,
  cooldowns: Map<string, { until: number }>,
  now: number
): KeySlot | null {
  const normModel = normalizeModelName(model);

  const readySlots = slots.filter((slot) => {
    if (!slot.enabled || slot.invalid) return false;
    const key = makeCooldownKey(slot.id, normModel);
    const cd = cooldowns.get(key);
    if (cd && cd.until > now) return false;
    return true;
  });

  if (readySlots.length === 0) return null;

  // LRU sorting: least recently used first (null lastUsedAt comes first)
  readySlots.sort((a, b) => {
    const aUsed = a.stats.lastUsedAt;
    const bUsed = b.stats.lastUsedAt;
    if (aUsed === null && bUsed === null) return a.id.localeCompare(b.id);
    if (aUsed === null) return -1;
    if (bUsed === null) return 1;
    return aUsed - bUsed;
  });

  return readySlots[0];
}

/**
 * Classifies HTTP errors and stream aborts according to Gemini API specs:
 * - 429 RetryInfo -> minute limit (retryDelay + 1s, default 60s)
 * - 429 PerDay / daily -> daily limit (cooldown until next midnight Pacific)
 * - 400 API_KEY_INVALID / 401 / 403 PERMISSION_DENIED -> invalid key
 * - First byte timeout -> suspect (10 min cooldown for that pair)
 * - 5xx / 503 UNAVAILABLE -> server (30s cooldown for that pair)
 * - Other 400 -> client-error (fail fast, do NOT rotate)
 * - Network / upload stall -> network error (fail fast, do NOT rotate)
 */
export function classifyFailure(
  status: number | null,
  body: any,
  phase: 'upload' | 'first-byte' | 'stream' | 'http',
  now = Date.now()
): Failure {
  // 1. Upload stall or network connection dropped
  if (phase === 'upload') {
    return { kind: 'network' };
  }

  // 2. First byte timed out (hung model or silent throttle)
  if (phase === 'first-byte') {
    return { kind: 'suspect', cooldownMs: 10 * 60 * 1000 }; // 10 minutes
  }

  // If status is null or 0 without HTTP response -> network error
  if (status === null || status === 0) {
    return { kind: 'network' };
  }

  // 3. Model side / server errors
  if (status >= 500 && status < 600) {
    return { kind: 'server', cooldownMs: 30 * 1000 }; // 30 seconds
  }

  // Extract raw error text and details
  const errorMessage: string = body?.error?.message || '';
  const errorStatus: string = body?.error?.status || '';
  const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];

  // 4. Invalid key detection
  if (status === 401) {
    return { kind: 'invalid' };
  }

  if (status === 403) {
    // 403 with PERMISSION_DENIED or API_KEY_INVALID
    if (
      errorStatus === 'PERMISSION_DENIED' ||
      /permission denied|api key|forbidden/i.test(errorMessage) ||
      details.some((d) => d?.reason === 'API_KEY_INVALID')
    ) {
      return { kind: 'invalid' };
    }
  }

  if (status === 400) {
    const isApiKeyInvalid =
      details.some((d) => d?.reason === 'API_KEY_INVALID') ||
      /API_KEY_INVALID|API key not valid|API key expired/i.test(errorMessage);

    if (isApiKeyInvalid) {
      return { kind: 'invalid' };
    }

    // Other 400: schema or parameter error -> client-error
    return { kind: 'client-error' };
  }

  // 5. Quota / Rate limit exhaustion: HTTP 429
  if (status === 429) {
    // Check if this is a daily quota limit
    const isDailyMessage = /per day|daily|perday/i.test(errorMessage);

    let isDailyViolation = false;
    let retryInfoDelaySeconds: number | null = null;

    for (const detail of details) {
      const typeStr = detail?.['@type'] || '';

      // Check QuotaFailure violations
      if (typeStr.includes('QuotaFailure') && Array.isArray(detail?.violations)) {
        for (const v of detail.violations) {
          const quotaId = v?.quotaId || '';
          const quotaMetric = v?.quotaMetric || '';
          const desc = v?.description || '';
          if (
            /PerDay|per_day/i.test(quotaId) ||
            /PerDay|per_day/i.test(quotaMetric) ||
            /per day|daily/i.test(desc)
          ) {
            isDailyViolation = true;
          }
        }
      }

      // Check RetryInfo
      if (typeStr.includes('RetryInfo') && detail?.retryDelay) {
        const delayStr = String(detail.retryDelay).trim();
        // e.g. "38s" or "38.5s" or "38"
        const secMatch = delayStr.match(/^([\d.]+)\s*s?$/);
        if (secMatch) {
          const parsed = parseFloat(secMatch[1]);
          if (!isNaN(parsed) && parsed >= 0) {
            retryInfoDelaySeconds = parsed;
          }
        }
      }
    }

    if (isDailyMessage || isDailyViolation) {
      const midnight = nextMidnightPacific(now);
      const cooldownMs = Math.max(1000, midnight - now);
      return { kind: 'daily', cooldownMs };
    }

    // Per-minute or default quota limit
    if (retryInfoDelaySeconds !== null) {
      // Cooldown = RetryInfo.retryDelay + 1 s
      const cooldownMs = Math.round((retryInfoDelaySeconds + 1) * 1000);
      return { kind: 'minute', cooldownMs };
    }

    // Default per-minute cooldown: 60s
    return { kind: 'minute', cooldownMs: 60 * 1000 };
  }

  return { kind: 'client-error' };
}

export interface PlannedAttempt {
  slot: KeySlot;
  model: string;
}

export type PlanResult =
  | { allBusy: false; attempts: PlannedAttempt[]; soonestReadyAt: null }
  | { allBusy: true; attempts: []; soonestReadyAt: number };

/**
 * Plans an ordered sequence of (key, model) attempts:
 * For each of the first 2 ranked models, every ready key in LRU order. Max 6 pairs.
 * If all keys are cooling down or no ready keys, returns { allBusy: true, soonestReadyAt }.
 */
export function planAttempts(
  rankedModels: string[],
  slots: KeySlot[],
  cooldowns: Map<string, { until: number }>,
  now = Date.now()
): PlanResult {
  const modelsToCheck = rankedModels.slice(0, 2).map(normalizeModelName);
  if (modelsToCheck.length === 0) {
    modelsToCheck.push('models/gemini-3.8-flash', 'models/gemini-3.7-flash');
  }

  const planned: PlannedAttempt[] = [];

  for (const model of modelsToCheck) {
    // Get all ready slots for this model
    const readyForModel = slots.filter((slot) => {
      if (!slot.enabled || slot.invalid) return false;
      const key = makeCooldownKey(slot.id, model);
      const cd = cooldowns.get(key);
      if (cd && cd.until > now) return false;
      return true;
    });

    // Sort LRU
    readyForModel.sort((a, b) => {
      const aUsed = a.stats.lastUsedAt;
      const bUsed = b.stats.lastUsedAt;
      if (aUsed === null && bUsed === null) return a.id.localeCompare(b.id);
      if (aUsed === null) return -1;
      if (bUsed === null) return 1;
      return aUsed - bUsed;
    });

    for (const slot of readyForModel) {
      if (planned.length >= 6) break;
      planned.push({ slot, model });
    }
    if (planned.length >= 6) break;
  }

  if (planned.length > 0) {
    return { allBusy: false, attempts: planned, soonestReadyAt: null };
  }

  // All keys are busy/cooling down. Calculate soonestReadyAt.
  const activeCooldowns: number[] = [];
  const candidateSlots = slots.filter((s) => s.enabled && !s.invalid);

  for (const slot of candidateSlots) {
    for (const model of modelsToCheck) {
      const key = makeCooldownKey(slot.id, model);
      const cd = cooldowns.get(key);
      if (cd && cd.until > now) {
        activeCooldowns.push(cd.until);
      }
    }
  }

  const soonestReadyAt =
    activeCooldowns.length > 0 ? Math.min(...activeCooldowns) : now + 60000;

  return {
    allBusy: true,
    attempts: [],
    soonestReadyAt,
  };
}

/**
 * Tracks recent quota failures to detect if different keys share the same project.
 * If 2 different keys get a quota failure on the same model within 3s, returns { shared: true, slotA, slotB }.
 */
const recentQuotaFailures: Array<{ slotId: SlotId; model: string; at: number }> = [];

export function recordQuotaFailureAndCheckSharedProject(
  slotId: SlotId,
  model: string,
  now = Date.now()
): { shared: boolean; otherSlotId?: SlotId } {
  const normModel = normalizeModelName(model);

  // Clean old entries older than 5s
  const cutoff = now - 5000;
  for (let i = recentQuotaFailures.length - 1; i >= 0; i--) {
    if (recentQuotaFailures[i].at < cutoff) {
      recentQuotaFailures.splice(i, 1);
    }
  }

  // Check if another slot had a quota failure on the same model within 3000ms
  for (const entry of recentQuotaFailures) {
    if (entry.slotId !== slotId && entry.model === normModel && Math.abs(now - entry.at) <= 3000) {
      recentQuotaFailures.push({ slotId, model: normModel, at: now });
      return { shared: true, otherSlotId: entry.slotId };
    }
  }

  recentQuotaFailures.push({ slotId, model: normModel, at: now });
  return { shared: false };
}
