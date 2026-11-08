/**
 * Pure REST client for Gemini generateContent and model discovery.
 * - Supports multi-key BYOK automatic rotation and quota scheduling.
 * - API keys strictly in x-goog-api-key header; NEVER in URLs, console, or error messages.
 * - Synchronous zero-delay key rotation on 429 quota exhaustion or suspect timeouts.
 * - Measures real switch time (switchMs).
 */

import {
  getKeySync,
  getAllCachedKeys,
  recordKeyCall,
  recordKeySuccess,
  recordKeyFailure,
  setSlotInvalid,
  listSlots,
} from './keyvault';
import {
  pickKey,
  planAttempts,
  classifyFailure,
  normalizeModelName,
  makeCooldownKey,
  nextMidnightPacific,
  isModelSlow,
  markModelSlow,
  routeNextAttempt,
} from './key-scheduler';
import {
  streamGeminiContent,
  GeminiHttpError,
  GeminiTimeoutError,
  GeminiUploadStallError,
} from './gemini-stream';
import { useKeyStore, AttemptLog } from '../stores/use-key-store';

const MODELS_CACHE_KEY = 'aiModelsCache';
const SELECTED_MODEL_KEY = 'sfx_ai_selected_model';
const NO_THINKING_KEY = 'no-thinking-config';

export function redactApiKey(text: string, apiKey?: string): string {
  if (!text) return '';
  let cleaned = text;

  if (apiKey && apiKey.length > 5) {
    cleaned = cleaned.replaceAll(apiKey, '[REDACTED]');
  }

  // Redact all cached keys from the vault
  const allKeys = getAllCachedKeys();
  for (const k of allKeys) {
    if (k && k.length > 5) {
      cleaned = cleaned.replaceAll(k, '[REDACTED]');
    }
  }

  // Redact general API key patterns
  cleaned = cleaned.replace(/AIza[0-9A-Za-z-_]{26,44}/g, '[REDACTED]');
  return cleaned;
}

export function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getAiCallsToday(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const slots = listSlots();
    const today = getTodayDateString();
    return slots.reduce((acc, s) => {
      if (s.stats?.dayKey === today) {
        return acc + (s.stats.callsToday || 0);
      }
      return acc;
    }, 0);
  } catch {
    return 0;
  }
}

export function getSelectedModel(): string {
  if (typeof window === 'undefined') return 'auto';
  try {
    return localStorage.getItem(SELECTED_MODEL_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function setSelectedModel(model: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, model);
  } catch (err) {
    console.warn('Failed to save selected model:', err);
  }
}

const inMemoryNoThinkingSet = new Set<string>();

export function isNoThinkingModel(model: string): boolean {
  const clean = model.replace(/^models\//, '');
  if (inMemoryNoThinkingSet.has(clean) || inMemoryNoThinkingSet.has(model)) {
    return true;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(NO_THINKING_KEY);
      if (raw) {
        const list: string[] = JSON.parse(raw);
        return list.includes(clean) || list.includes(model);
      }
    } catch {}
  }
  return false;
}

export function markNoThinkingModel(model: string): void {
  const clean = model.replace(/^models\//, '');
  inMemoryNoThinkingSet.add(clean);
  inMemoryNoThinkingSet.add(model);
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(NO_THINKING_KEY);
      const list: string[] = raw ? JSON.parse(raw) : [];
      if (!list.includes(clean)) {
        list.push(clean);
        localStorage.setItem(NO_THINKING_KEY, JSON.stringify(list));
      }
    } catch {}
  }
}

export function rankGeminiModels(models: string[]): string[] {
  return [...models].sort((a, b) => {
    // Models marked slow for 6h rank last
    const isSlowA = isModelSlow(a);
    const isSlowB = isModelSlow(b);
    if (isSlowA !== isSlowB) {
      return isSlowA ? 1 : -1;
    }

    const isProA = /pro/i.test(a);
    const isProB = /pro/i.test(b);

    const isPreviewA = /preview|exp|experimental/i.test(a);
    const isPreviewB = /preview|exp|experimental/i.test(b);

    const isLiteA = /flash-lite|lite/i.test(a);
    const isLiteB = /flash-lite|lite/i.test(b);

    const isFlashA = /flash/i.test(a) && !isLiteA;
    const isFlashB = /flash/i.test(b) && !isLiteB;

    // Rank tier: stable flash (4) > preview flash (3) > flash-lite (2) > pro (0)
    const getTier = (isPro: boolean, isFlash: boolean, isLite: boolean, isPreview: boolean) => {
      if (isPro) return 0;
      if (isFlash && !isPreview) return 4;
      if (isFlash && isPreview) return 3;
      if (isLite && !isPreview) return 2;
      if (isLite && isPreview) return 1;
      return 0;
    };

    const tierA = getTier(isProA, isFlashA, isLiteA, isPreviewA);
    const tierB = getTier(isProB, isFlashB, isLiteB, isPreviewB);

    if (tierB !== tierA) return tierB - tierA;

    // Version ranking (higher version first)
    const vMatchA = a.match(/gemini-(\d+(\.\d+)?)/i);
    const vMatchB = b.match(/gemini-(\d+(\.\d+)?)/i);
    const vA = vMatchA ? parseFloat(vMatchA[1]) : 0;
    const vB = vMatchB ? parseFloat(vMatchB[1]) : 0;
    if (vB !== vA) return vB - vA;

    return a.localeCompare(b);
  });
}

export const FASTEST_MODEL_CACHE_KEY = 'sfx_ai_fastest_model_cache';

/**
 * Sends a lightweight text-only ping ("Reply with the word OK", max 16 tokens) to test model response time.
 */
export async function pingModel(
  model: string,
  rawKey: string,
  timeoutMs = 8000
): Promise<{ latencyMs: number; ok: boolean }> {
  const normModel = normalizeModelName(model);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${normModel}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': rawKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with the word OK' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - start);
    return { latencyMs, ok: res.ok };
  } catch {
    clearTimeout(timer);
    return { latencyMs: 99999, ok: false };
  }
}

/**
 * Runs parallel pings across top candidate flash models to select the fastest.
 * Result is cached for 30 minutes in localStorage.
 */
export async function pickFastestModel(
  candidateModels: string[],
  rawKey: string,
  keyLabel?: string,
  forcePing = false
): Promise<string> {
  if (candidateModels.length === 0) return 'models/gemini-3.8-flash';
  if (candidateModels.length === 1) return candidateModels[0];

  // Check 30-min cache
  if (!forcePing && typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(FASTEST_MODEL_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const age = Date.now() - (parsed.timestamp || 0);
        if (age < 30 * 60 * 1000 && parsed.model && !isModelSlow(parsed.model)) {
          const norm = normalizeModelName(parsed.model);
          if (candidateModels.map(normalizeModelName).includes(norm)) {
            return norm;
          }
        }
      }
    } catch {}
  }

  const top3 = candidateModels.slice(0, 3);
  const results = await Promise.all(
    top3.map(async (m) => {
      const pingRes = await pingModel(m, rawKey, 8000);
      if (pingRes.ok) {
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: keyLabel || 'Key',
          model: m.replace(/^models\//, ''),
          phase: 'ping',
          result: 'ok',
          durationMs: pingRes.latencyMs,
        });
      }
      return { model: m, ...pingRes };
    })
  );

  const successful = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  if (successful.length > 0) {
    const fastest = successful[0];
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(
          FASTEST_MODEL_CACHE_KEY,
          JSON.stringify({ model: fastest.model, latencyMs: fastest.latencyMs, timestamp: Date.now() })
        );
      } catch {}
    }
    return fastest.model;
  }

  return top3[0];
}

/**
 * Discovers, filters, and ranks available Gemini models.
 * If apiKey is omitted, uses any ready key from the scheduler.
 */
export async function discoverGeminiModels(
  apiKey?: string,
  forceRefresh = false
): Promise<string[]> {
  // Check 24h cache first
  if (!forceRefresh && typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(MODELS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        const age = Date.now() - (parsed.timestamp || 0);
        if (age < 24 * 60 * 60 * 1000 && Array.isArray(parsed.models) && parsed.models.length > 0) {
          return parsed.models;
        }
      }
    } catch {}
  }

  let cleanKey = apiKey ? apiKey.trim() : '';

  if (!cleanKey) {
    // Pick any ready key from slots
    const slots = listSlots();
    const readySlot = slots.find((s) => s.enabled && !s.invalid);
    if (readySlot) {
      cleanKey = getKeySync(readySlot.id) || '';
    }
  }

  if (!cleanKey) {
    return ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-2.5-flash'];
  }

  const allModels: { name: string; supportedGenerationMethods?: string[] }[] = [];
  let pageToken: string | undefined = undefined;
  const endpointBase = 'https://generativelanguage.googleapis.com/v1beta/models';

  do {
    const url = new URL(endpointBase);
    url.searchParams.set('pageSize', '200');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-goog-api-key': cleanKey,
      },
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error?.message) {
          detail = `${detail} - ${body.error.message}`;
        }
      } catch {}
      throw new Error(redactApiKey(detail, cleanKey));
    }

    const data = await res.json();
    if (Array.isArray(data?.models)) {
      allModels.push(...data.models);
    }
    pageToken = data?.nextPageToken;
  } while (pageToken);

  const excludeRegex = /(embedding|tts|image|live|audio-dialog|robotics|computer-use|learnlm|gemma|aqa)/i;

  const filteredNames = allModels
    .filter((m) => {
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) return false;
      if (!/gemini/i.test(m.name)) return false;
      if (excludeRegex.test(m.name)) return false;
      return true;
    })
    .map((m) => m.name);

  const ranked = rankGeminiModels(filteredNames);

  if (typeof window !== 'undefined' && ranked.length > 0) {
    try {
      localStorage.setItem(
        MODELS_CACHE_KEY,
        JSON.stringify({ timestamp: Date.now(), models: ranked })
      );
    } catch (err) {
      console.warn('Failed to write models cache to localStorage:', err);
    }
  }

  return ranked;
}

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64
  };
}

export interface GeminiGenerateContentRequest {
  contents: {
    role?: string;
    parts: GeminiPart[];
  }[];
  generationConfig?: {
    temperature?: number;
    responseMimeType?: string;
    responseSchema?: Record<string, any>;
    maxOutputTokens?: number;
    mediaResolution?: string;
    thinkingConfig?: {
      thinkingBudget?: number;
      thinkingLevel?: string;
    };
  };
}

export function getThinkingConfigForModel(
  model: string
): { thinkingBudget?: number; thinkingLevel?: string } | undefined {
  if (isNoThinkingModel(model)) return undefined;

  const lower = model.toLowerCase();
  if (lower.includes('2.5-flash') || lower.includes('2.5-flash-lite')) {
    return { thinkingBudget: 0 };
  }
  if (
    lower.includes('gemini-3') ||
    lower.includes('gemini-3.') ||
    lower.includes('gemini-4') ||
    lower.includes('3.8-flash') ||
    lower.includes('3.7-flash') ||
    lower.includes('3.1-flash')
  ) {
    if (lower.includes('flash-lite') || lower.includes('lite')) {
      return { thinkingLevel: 'minimal' };
    }
    return { thinkingLevel: 'low' };
  }

  return undefined;
}

export function buildGeminiGenerateContentBody(
  parts: GeminiPart[],
  schema: Record<string, any>,
  temperature = 0.2,
  modelName = 'gemini-3.8-flash'
): GeminiGenerateContentRequest {
  const thinkingConfig = getThinkingConfigForModel(modelName);
  const lower = modelName.toLowerCase();
  const isGemini3OrNewer =
    lower.includes('gemini-3') ||
    lower.includes('gemini-4') ||
    lower.includes('3.8-flash') ||
    lower.includes('3.7-flash') ||
    lower.includes('3.1-flash');

  const config: Record<string, any> = {
    maxOutputTokens: isGemini3OrNewer ? 8192 : 4096,
    responseMimeType: 'application/json',
    responseSchema: schema,
    mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
  };

  // Only send temperature for 2.5 and older models (omit for gemini-3+ to use API default 1.0)
  if (!isGemini3OrNewer) {
    config.temperature = temperature ?? 0.2;
  }

  if (thinkingConfig) {
    config.thinkingConfig = thinkingConfig;
  }

  return {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: config,
  };
}

export interface GeminiCallProgress {
  model: string;
  keyLabel?: string;
  attempt: number;
  totalAttempts: number;
  elapsedSeconds: number;
  previousReason?: string;
  rotationLine?: string;
}

export interface CallGeminiOptions {
  preferredModel?: string;
  signal?: AbortSignal;
  onProgress?: (info: GeminiCallProgress) => void;
  onToastSwitch?: (msg: string) => void;
}

/**
 * Universal dispatcher for Gemini generateContent calls with multi-key automatic rotation.
 * Supports:
 * - callGeminiGenerateContent(body, options)
 * - callGeminiGenerateContent(apiKey, body, options) [backward compatibility]
 */
export async function callGeminiGenerateContent(
  firstArg: string | GeminiGenerateContentRequest,
  secondArg?: GeminiGenerateContentRequest | CallGeminiOptions,
  thirdArg?: CallGeminiOptions
): Promise<{ text: string; modelUsed: string; keyUsed: string; attemptsCount: number }> {
  let body: GeminiGenerateContentRequest;
  let options: CallGeminiOptions | undefined;
  let singleOverrideKey: string | null = null;

  if (typeof firstArg === 'string') {
    singleOverrideKey = firstArg.trim();
    body = secondArg as GeminiGenerateContentRequest;
    options = thirdArg;
  } else {
    body = firstArg;
    options = secondArg as CallGeminiOptions;
  }

  const stepStartMs = performance.now();
  const TOTAL_STEP_DEADLINE_MS = 150000; // 150s total deadline

  // Discover & rank models
  let discovered: string[] = [];
  try {
    discovered = await discoverGeminiModels(singleOverrideKey || undefined);
  } catch {
    discovered = ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-2.5-flash'];
  }

  const autoModels = discovered.filter((m) => !/pro/i.test(m));
  if (autoModels.length === 0) {
    autoModels.push('models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-2.5-flash');
  }

  const userModel =
    options?.preferredModel && options.preferredModel !== 'auto'
      ? options.preferredModel
      : getSelectedModel();

  let candidateModels: string[] = [];
  if (userModel && userModel !== 'auto') {
    // Manual selection in Settings always wins
    candidateModels = [userModel, ...autoModels.filter((m) => m !== userModel)];
  } else {
    candidateModels = autoModels;
  }

  // Load slots from store/vault
  let slots = listSlots();
  if (singleOverrideKey && slots.length === 0) {
    slots = [
      {
        id: 'k1',
        label: 'Key 1',
        last4: singleOverrideKey.slice(-4),
        enabled: true,
        invalid: false,
        addedAt: Date.now(),
        tested: true,
        stats: {
          dayKey: getTodayDateString(),
          callsToday: 0,
          lastUsedAt: null,
          lastOkAt: null,
          lastError: null,
        },
      },
    ];
  }

  const enabledSlots = slots.filter((s) => s.enabled && !s.invalid);
  if (enabledSlots.length === 0 && !singleOverrideKey) {
    throw new Error('Add a Gemini API key in Settings');
  }

  // Cooldown map
  const getCooldownMap = () => {
    const map = new Map<string, { until: number }>();
    for (const [k, v] of Object.entries(useKeyStore.getState().cooldowns)) {
      if (v && v.until > Date.now()) {
        map.set(k, v);
      }
    }
    return map;
  };

  // Pre-flight model ping in Auto mode across top candidate flash models when sending multimodal media payload
  const hasMediaPayload = body?.contents?.some((c) =>
    c.parts?.some((p) => Boolean(p.inlineData))
  );

  if (hasMediaPayload && !singleOverrideKey && (!userModel || userModel === 'auto')) {
    const initialReadySlot = pickKey(slots, candidateModels[0], getCooldownMap(), Date.now());
    const initialKey = initialReadySlot ? getKeySync(initialReadySlot.id) : null;
    if (initialKey) {
      try {
        const fastest = await pickFastestModel(candidateModels, initialKey, initialReadySlot?.label);
        const normFastest = normalizeModelName(fastest);
        candidateModels = [
          normFastest,
          ...candidateModels.filter((m) => normalizeModelName(m) !== normFastest),
        ];
      } catch (pingErr) {
        console.warn('Pre-flight ping failed, proceeding with ranked order:', pingErr);
      }
    }
  }

  // Pick initial model and key
  let currentModel = normalizeModelName(candidateModels[0]);
  let currentSlot = pickKey(slots, currentModel, getCooldownMap(), Date.now());

  if (!currentSlot) {
    // Try other candidate models
    for (const m of candidateModels) {
      const s = pickKey(slots, m, getCooldownMap(), Date.now());
      if (s) {
        currentModel = normalizeModelName(m);
        currentSlot = s;
        break;
      }
    }
  }

  // Handle allBusy if no slot is ready
  if (!currentSlot) {
    const plan = planAttempts(candidateModels, slots, getCooldownMap(), Date.now());
    if (plan.allBusy) {
      const waitMs = plan.soonestReadyAt - Date.now();
      if (useKeyStore.getState().autoRetryWhenBusy && waitMs > 0 && waitMs <= 90000) {
        const waitSec = Math.ceil(waitMs / 1000);
        options?.onProgress?.({
          model: currentModel,
          attempt: 1,
          totalAttempts: 1,
          elapsedSeconds: 0,
          previousReason: `All keys cooling down. Auto-retrying in ${waitSec}s...`,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs + 500));
        currentSlot = pickKey(listSlots(), currentModel, getCooldownMap(), Date.now());
      }
      if (!currentSlot) {
        const waitSec = Math.max(1, Math.ceil((plan.soonestReadyAt - Date.now()) / 1000));
        throw new Error(`All keys are at their limit. Next key ready in ${waitSec} s.`);
      }
    } else if (plan.attempts.length > 0) {
      currentSlot = plan.attempts[0].slot;
      currentModel = normalizeModelName(plan.attempts[0].model);
    } else {
      throw new Error('No ready API key found. Add or enable a key in Settings.');
    }
  }

  let attemptCount = 0;
  const maxAttempts = 6;
  let previousReason: string | undefined = undefined;
  let previousSlotLabel: string | undefined = undefined;
  let rotationLine = '';
  let lastFailureDetectedAt = 0;
  let thinkingFallbackRetried = false;
  let lastError: Error | null = null;

  while (attemptCount < maxAttempts) {
    // Stop if total deadline exceeded (150 s)
    if (performance.now() - stepStartMs >= TOTAL_STEP_DEADLINE_MS) {
      throw new Error('The AI did not answer in time. Check your connection, or try again.');
    }

    if (options?.signal?.aborted) {
      throw new Error('Analysis cancelled by user.');
    }

    attemptCount++;
    if (!currentSlot) {
      throw new Error('No ready API key found.');
    }
    const currentSlotId = currentSlot.id;
    const currentSlotLabel = currentSlot.label;

    const modelClean = currentModel.replace(/^models\//, '');
    const rawKey = singleOverrideKey || getKeySync(currentSlotId);

    if (!rawKey) {
      // Pick next key
      const nextSlot = pickKey(slots.filter((s) => s.id !== currentSlotId), currentModel, getCooldownMap(), Date.now());
      if (nextSlot) {
        currentSlot = nextSlot;
        continue;
      }
      throw new Error('No valid API key available.');
    }

    // Check for developer simulation interceptor
    const simulated = useKeyStore.getState().consumeSimulatedFailure(currentSlot.id);
    if (simulated) {
      useKeyStore.getState().applyCooldown(currentSlot.id, currentModel, simulated.cooldownMs, simulated.kind);
      useKeyStore.getState().recordAttempt({
        time: Date.now(),
        keyLabel: currentSlot.label,
        model: modelClean,
        phase: 'http',
        result: `simulated 429 (${simulated.kind})`,
        durationMs: 12,
        simulated: true,
      });

      const retryInSec = Math.round(simulated.cooldownMs / 1000);
      const dec = routeNextAttempt(
        currentSlot,
        currentModel,
        { kind: simulated.kind, cooldownMs: simulated.cooldownMs },
        candidateModels,
        listSlots(),
        getCooldownMap(),
        Date.now()
      );

      if (dec.type === 'retry_next_key') {
        rotationLine = `${currentSlot.label} · ${modelClean} · simulated 429 (${retryInSec}s) -> ${dec.slot.label}`;
        previousReason = `simulated 429 on ${currentSlot.label}`;
        previousSlotLabel = currentSlot.label;
        currentSlot = dec.slot;
      } else if (dec.type === 'switch_model') {
        rotationLine = `${currentSlot.label} · ${modelClean} · simulated 429 (${retryInSec}s) -> ${dec.model.replace(/^models\//, '')}`;
        previousReason = `simulated 429 on ${currentSlot.label}`;
        previousSlotLabel = currentSlot.label;
        currentModel = dec.model;
        currentSlot = dec.slot;
      }
      lastFailureDetectedAt = performance.now();
      continue;
    }

    // Build model-specific body
    let currentBody = { ...body };
    const currentThinkingConfig = getThinkingConfigForModel(currentModel);
    const lower = currentModel.toLowerCase();
    const isGemini3OrNewer =
      lower.includes('gemini-3') ||
      lower.includes('gemini-4') ||
      lower.includes('3.8-flash') ||
      lower.includes('3.7-flash') ||
      lower.includes('3.1-flash');

    const updatedGenConfig = {
      ...currentBody.generationConfig,
      maxOutputTokens: isGemini3OrNewer ? 8192 : 4096,
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    };

    if (isGemini3OrNewer) {
      delete updatedGenConfig.temperature; // Do not send temperature on Gemini 3+
    }

    if (currentThinkingConfig) {
      updatedGenConfig.thinkingConfig = currentThinkingConfig;
    } else {
      delete updatedGenConfig.thinkingConfig;
    }

    currentBody.generationConfig = updatedGenConfig;

    // Check if this was a switch from previous failure
    if (lastFailureDetectedAt > 0) {
      const switchMs = Math.round(performance.now() - lastFailureDetectedAt);
      const switchInfo = {
        fromLabel: previousSlotLabel || currentSlot.label,
        toLabel: currentSlot.label,
        reason: previousReason || 'Limit reached',
        ms: switchMs,
        at: Date.now(),
      };
      useKeyStore.getState().recordSwitch(switchInfo);
      if (rotationLine) {
        options?.onToastSwitch?.(rotationLine);
      }
      lastFailureDetectedAt = 0;
      previousSlotLabel = undefined;
    }

    const reqStartMs = performance.now();
    recordKeyCall(currentSlot.id);

    try {
      const res = await streamGeminiContent(currentModel, rawKey, currentBody, {
        signal: options?.signal,
        onProgress: (prog) => {
          options?.onProgress?.({
            model: currentModel,
            keyLabel: currentSlotLabel,
            attempt: attemptCount,
            totalAttempts: maxAttempts,
            elapsedSeconds: Math.round((performance.now() - reqStartMs) / 1000),
            previousReason,
            rotationLine: prog.detail || rotationLine,
          });
        },
      });

      // Request succeeded!
      recordKeySuccess(currentSlot.id);
      const totalDurationMs = Math.round(performance.now() - reqStartMs);

      useKeyStore.getState().recordAttempt({
        time: Date.now(),
        keyLabel: currentSlot.label,
        model: modelClean,
        phase: res.phase || 'stream',
        result: 'ok',
        durationMs: totalDurationMs,
        uploadedBytes: res.uploadedBytes,
        uploadMs: res.uploadMs,
        waitMs: res.waitMs,
        receiveMs: res.receiveMs,
        tokens: res.usageMetadata?.totalTokenCount,
        tokensIn: res.usageMetadata?.promptTokenCount,
        tokensThought: res.usageMetadata?.thinkingTokenCount,
        tokensOut: res.usageMetadata?.candidatesTokenCount,
        temperature: currentBody.generationConfig?.temperature,
        thinkingConfig: currentThinkingConfig?.thinkingLevel || (currentThinkingConfig?.thinkingBudget !== undefined ? `budget:${currentThinkingConfig.thinkingBudget}` : undefined),
      });

      return {
        text: res.text,
        modelUsed: currentModel,
        keyUsed: currentSlot.label,
        attemptsCount: attemptCount,
      };
    } catch (err: any) {
      const failureTime = performance.now();
      const reqDurationMs = Math.round(failureTime - reqStartMs);

      if (options?.signal?.aborted) {
        throw new Error('Analysis cancelled by user.');
      }

      // Check for 400 thinking config error fallback (same key and model, retry once without thinkingConfig)
      if (
        err instanceof GeminiHttpError &&
        err.status === 400 &&
        !thinkingFallbackRetried &&
        /(thinking|thinkingConfig|thinkingLevel|thinkingBudget)/i.test(err.message)
      ) {
        markNoThinkingModel(currentModel);
        thinkingFallbackRetried = true;
        attemptCount--;
        continue;
      }

      // Handle upload stall
      if (err instanceof GeminiUploadStallError) {
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase: 'upload',
          result: 'upload stalled',
          durationMs: reqDurationMs,
        });
        throw new Error('Upload stalled for 25 s without network progress. Check your connection, or try again.');
      }

      // Classify failure
      let failure: any;
      let phase: 'upload' | 'first-byte' | 'stream' | 'http' = 'http';

      if (err instanceof GeminiTimeoutError) {
        phase = err.phase;
        failure = { kind: 'suspect', cooldownMs: 10 * 60 * 1000 };
      } else if (err instanceof GeminiHttpError) {
        phase = err.phase;
        failure = classifyFailure(err.status, err.body, phase, Date.now());
      } else {
        failure = classifyFailure(null, null, 'upload', Date.now());
      }

      const safeMsg = redactApiKey(err?.message || 'AI request failed', rawKey);
      recordKeyFailure(currentSlot.id, safeMsg);
      lastError = new Error(safeMsg);

      // Stop immediately on client-error or general network drop (do NOT rotate)
      if (failure.kind === 'client-error') {
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase,
          result: `client-error (${err?.status || 400})`,
          durationMs: reqDurationMs,
        });
        throw new Error(safeMsg);
      }

      if (failure.kind === 'network') {
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase: 'upload',
          result: 'network error',
          durationMs: reqDurationMs,
        });
        throw new Error(safeMsg);
      }

      // Apply cooldowns / invalidation based on failure type
      if (failure.kind === 'invalid') {
        setSlotInvalid(currentSlot.id, true, safeMsg);
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase,
          result: 'invalid key',
          durationMs: reqDurationMs,
        });
      } else if (failure.kind === 'minute' || failure.kind === 'daily') {
        useKeyStore.getState().applyCooldown(currentSlot.id, currentModel, failure.cooldownMs, failure.kind);
        useKeyStore.getState().checkSharedProjectFailure(currentSlot.id, currentModel);

        const reasonLabel = failure.kind === 'minute' ? '429 per-minute' : '429 daily limit';
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase,
          result: reasonLabel,
          durationMs: reqDurationMs,
        });
      } else if (failure.kind === 'suspect') {
        useKeyStore.getState().applyCooldown(currentSlot.id, currentModel, failure.cooldownMs, 'suspect');
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase,
          result: 'suspect timeout',
          durationMs: reqDurationMs,
        });
      } else if (failure.kind === 'server') {
        useKeyStore.getState().applyCooldown(currentSlot.id, currentModel, failure.cooldownMs, 'server');
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: currentSlot.label,
          model: modelClean,
          phase,
          result: `5xx server (${err?.status || 500})`,
          durationMs: reqDurationMs,
        });
      }

      // Route next attempt dynamically according to user specification:
      // - quota (429): SAME model, NEXT KEY. If no other key, next model.
      // - invalid key: NEXT KEY, same model.
      // - first-byte timeout / idle stream / 5xx: mark model slow for 6 h, go to NEXT MODEL with SAME KEY.
      const decision = routeNextAttempt(
        currentSlot,
        currentModel,
        failure,
        candidateModels,
        listSlots(),
        getCooldownMap(),
        Date.now()
      );

      lastFailureDetectedAt = failureTime;
      previousReason = safeMsg;

      if (decision.type === 'retry_next_key') {
        rotationLine = `${currentSlot.label} · ${modelClean} · limit reached -> switching to ${decision.slot.label}`;
        previousSlotLabel = currentSlot.label;
        currentSlot = decision.slot;
        continue;
      }

      if (decision.type === 'switch_model') {
        rotationLine = `${currentSlot.label} · ${modelClean} · switching to ${decision.model.replace(/^models\//, '')}`;
        previousSlotLabel = currentSlot.label;
        currentModel = decision.model;
        currentSlot = decision.slot;
        continue;
      }

      if (decision.type === 'all_busy') {
        const waitSec = Math.max(1, Math.ceil((decision.soonestReadyAt - Date.now()) / 1000));
        throw new Error(`All keys are at their limit. Next key ready in ${waitSec} s.`);
      }

      if (decision.type === 'stop') {
        throw new Error(decision.error || safeMsg);
      }
    }
  }

  throw lastError || new Error('The AI did not answer in time. Check your connection, or try again.');
}

/**
 * Sends a tiny text-only request ("Reply with OK") to test model latency in Settings.
 */
export async function testAiSpeed(
  apiKey?: string,
  preferredModel?: string
): Promise<{ latencyMs: number; modelUsed: string }> {
  const start = performance.now();
  const body: GeminiGenerateContentRequest = {
    contents: [
      {
        parts: [{ text: 'Reply with OK' }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16,
    },
  };

  const res = await callGeminiGenerateContent(
    apiKey ? apiKey : body,
    apiKey ? body : { preferredModel },
    apiKey ? { preferredModel } : undefined
  );

  const latencyMs = Math.round(performance.now() - start);
  return { latencyMs, modelUsed: res.modelUsed };
}
