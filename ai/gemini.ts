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
} from './key-scheduler';
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
    lower.includes('3.8-flash') ||
    lower.includes('3.7-flash')
  ) {
    return { thinkingLevel: 'LOW' };
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

  return {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: schema,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
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
  const PER_REQUEST_TIMEOUT_MS = 60000; // 60s request timeout

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
    candidateModels = [userModel, ...autoModels.filter((m) => m !== userModel)];
  } else {
    candidateModels = autoModels;
  }

  // Load slots from store/vault
  let slots = listSlots();
  if (singleOverrideKey && slots.length === 0) {
    // Ephemeral single slot if called directly with a key before initialization
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

  // Plan rotation sequence
  const keyStore = useKeyStore.getState();
  const cooldownMap = new Map<string, { until: number }>();
  for (const [k, v] of Object.entries(keyStore.cooldowns)) {
    if (v && v.until > Date.now()) {
      cooldownMap.set(k, v);
    }
  }

  let plan = planAttempts(candidateModels, slots, cooldownMap, Date.now());

  // Handle allBusy
  if (plan.allBusy) {
    const now = Date.now();
    const waitMs = plan.soonestReadyAt - now;

    if (keyStore.autoRetryWhenBusy && waitMs > 0 && waitMs <= 90000) {
      // Auto-retry once when wait is <= 90s
      const waitSeconds = Math.ceil(waitMs / 1000);
      options?.onProgress?.({
        model: candidateModels[0],
        attempt: 1,
        totalAttempts: 1,
        elapsedSeconds: 0,
        previousReason: `All keys cooling down. Auto-retrying in ${waitSeconds}s...`,
      });

      await new Promise((resolve) => setTimeout(resolve, waitMs + 500));

      // Re-plan after waiting
      const updatedCooldownMap = new Map<string, { until: number }>();
      for (const [k, v] of Object.entries(useKeyStore.getState().cooldowns)) {
        if (v && v.until > Date.now()) {
          updatedCooldownMap.set(k, v);
        }
      }
      plan = planAttempts(candidateModels, listSlots(), updatedCooldownMap, Date.now());
    }

    if (plan.allBusy) {
      const waitSec = Math.max(1, Math.ceil((plan.soonestReadyAt - Date.now()) / 1000));
      throw new Error(`All keys are at their limit. Next key ready in ${waitSec} s.`);
    }
  }

  const attemptsToRun = plan.attempts;
  let totalAttemptsCount = 0;
  let previousReason: string | undefined = undefined;
  let rotationLine = '';
  let lastError: Error | null = null;
  let lastFailureDetectedAt = 0;

  for (let i = 0; i < attemptsToRun.length; i++) {
    const { slot, model: currentModel } = attemptsToRun[i];
    const modelClean = currentModel.replace(/^models\//, '');
    const modelPath = normalizeModelName(currentModel);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;

    // Stop if total deadline exceeded
    if (performance.now() - stepStartMs >= TOTAL_STEP_DEADLINE_MS) {
      throw new Error('The AI did not answer in time. Check your connection, or try again.');
    }

    if (options?.signal?.aborted) {
      throw new Error('Analysis cancelled by user.');
    }

    totalAttemptsCount++;

    // Check for developer simulation interceptor
    const simulated = useKeyStore.getState().consumeSimulatedFailure(slot.id);
    if (simulated) {
      useKeyStore.getState().applyCooldown(slot.id, modelPath, simulated.cooldownMs, simulated.kind);
      useKeyStore.getState().recordAttempt({
        time: Date.now(),
        keyLabel: slot.label,
        model: modelClean,
        phase: 'http',
        result: `simulated 429 (${simulated.kind})`,
        durationMs: 12,
        simulated: true,
      });

      const retryInSec = Math.round(simulated.cooldownMs / 1000);
      const nextAttempt = attemptsToRun[i + 1];
      if (nextAttempt) {
        rotationLine = `${slot.label} · ${modelClean} · simulated 429 (${retryInSec}s) -> ${nextAttempt.slot.label}`;
        previousReason = `simulated 429 on ${slot.label}`;
      }
      lastFailureDetectedAt = performance.now();
      continue;
    }

    // Retrieve raw key
    const rawKey = singleOverrideKey || getKeySync(slot.id);
    if (!rawKey) {
      continue;
    }

    // Build model-specific thinking config
    let currentBody = { ...body };
    const currentThinkingConfig = getThinkingConfigForModel(modelPath);
    if (currentThinkingConfig) {
      currentBody = {
        ...currentBody,
        generationConfig: {
          ...currentBody.generationConfig,
          thinkingConfig: currentThinkingConfig,
          maxOutputTokens: 4096,
        },
      };
    } else if (currentBody.generationConfig) {
      const { thinkingConfig, ...restConfig } = currentBody.generationConfig;
      currentBody = {
        ...currentBody,
        generationConfig: {
          ...restConfig,
          maxOutputTokens: 4096,
        },
      };
    }

    // Check if this was a switch from a previous failure
    if (lastFailureDetectedAt > 0) {
      const switchMs = Math.round(performance.now() - lastFailureDetectedAt);
      const prevAttempt = attemptsToRun[i - 1];
      if (prevAttempt) {
        const switchInfo = {
          fromLabel: prevAttempt.slot.label,
          toLabel: slot.label,
          reason: previousReason || 'Quota limit',
          ms: switchMs,
          at: Date.now(),
        };
        useKeyStore.getState().recordSwitch(switchInfo);
        const switchToast = `${prevAttempt.slot.label} hit its limit — switched to ${slot.label} (${switchMs} ms)`;
        options?.onToastSwitch?.(switchToast);
      }
      lastFailureDetectedAt = 0;
    }

    const timeoutController = new AbortController();
    let timedOutFirstByte = false;

    const timeoutId = setTimeout(() => {
      timedOutFirstByte = true;
      timeoutController.abort(new Error('First byte timed out'));
    }, PER_REQUEST_TIMEOUT_MS);

    const abortHandler = () => {
      timeoutController.abort(new Error('Analysis cancelled by user.'));
    };

    if (options?.signal) {
      options.signal.addEventListener('abort', abortHandler);
    }

    const reqStartMs = performance.now();
    const progressTimer = setInterval(() => {
      const elapsed = Math.round((performance.now() - reqStartMs) / 1000);
      options?.onProgress?.({
        model: modelPath,
        keyLabel: slot.label,
        attempt: totalAttemptsCount,
        totalAttempts: attemptsToRun.length,
        elapsedSeconds: elapsed,
        previousReason,
        rotationLine,
      });
    }, 250);

    let thinkingFallbackRetried = false;

    try {
      recordKeyCall(slot.id);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': rawKey,
        },
        body: JSON.stringify(currentBody),
        signal: timeoutController.signal,
      });

      clearInterval(progressTimer);
      clearTimeout(timeoutId);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }

      const reqDurationMs = Math.round(performance.now() - reqStartMs);

      if (response.ok) {
        const json = await response.json();
        const candidateText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const totalTokens = json?.usageMetadata?.totalTokenCount;

        recordKeySuccess(slot.id);
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'http',
          result: 'ok',
          durationMs: reqDurationMs,
          tokens: totalTokens,
        });

        return {
          text: candidateText,
          modelUsed: modelPath,
          keyUsed: slot.label,
          attemptsCount: totalAttemptsCount,
        };
      }

      // Handle non-OK response
      const status = response.status;
      let errBody: any = null;
      let rawMsg = `HTTP ${status}`;

      try {
        errBody = await response.json();
        if (errBody?.error?.message) {
          rawMsg = `HTTP ${status} (${errBody.error.message})`;
        }
      } catch {}

      const safeMsg = redactApiKey(rawMsg, rawKey);

      // Check for 400 Thinking config error fallback (same key, instant retry)
      if (
        status === 400 &&
        !thinkingFallbackRetried &&
        /(thinking|thinkingConfig|thinkingLevel|thinkingBudget)/i.test(rawMsg)
      ) {
        markNoThinkingModel(modelPath);
        thinkingFallbackRetried = true;
        totalAttemptsCount--;
        i--; // retry same key without thinking
        continue;
      }

      const failureTime = performance.now();
      const failure = classifyFailure(status, errBody, 'http', Date.now());

      recordKeyFailure(slot.id, safeMsg);

      if (failure.kind === 'client-error') {
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'http',
          result: `client-error (${status})`,
          durationMs: reqDurationMs,
        });
        throw new Error(safeMsg);
      }

      if (failure.kind === 'network') {
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'upload',
          result: 'network error',
          durationMs: reqDurationMs,
        });
        throw new Error(safeMsg);
      }

      if (failure.kind === 'invalid') {
        setSlotInvalid(slot.id, true, safeMsg);
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'http',
          result: 'invalid key',
          durationMs: reqDurationMs,
        });
      } else if (failure.kind === 'minute' || failure.kind === 'daily') {
        useKeyStore.getState().applyCooldown(slot.id, modelPath, failure.cooldownMs, failure.kind);
        useKeyStore.getState().checkSharedProjectFailure(slot.id, modelPath);

        const reasonLabel = failure.kind === 'minute' ? '429 per-minute' : '429 daily limit';
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'http',
          result: reasonLabel,
          durationMs: reqDurationMs,
        });
      } else if (failure.kind === 'server') {
        useKeyStore.getState().applyCooldown(slot.id, modelPath, failure.cooldownMs, 'server');
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'http',
          result: `5xx server (${status})`,
          durationMs: reqDurationMs,
        });
      }

      const nextAttempt = attemptsToRun[i + 1];
      if (nextAttempt) {
        const retrySec =
          failure.kind === 'minute'
            ? Math.round((failure as any).cooldownMs / 1000)
            : 60;
        rotationLine = `${slot.label} · ${modelClean} · 429 (retry in ${retrySec}s) -> ${nextAttempt.slot.label}`;
      }

      previousReason = safeMsg;
      lastError = new Error(safeMsg);
      lastFailureDetectedAt = failureTime;
      continue; // Move immediately (synchronously) to the next pair
    } catch (reqErr) {
      clearInterval(progressTimer);
      clearTimeout(timeoutId);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }

      if (options?.signal?.aborted) {
        throw new Error('Analysis cancelled by user.');
      }

      const failureTime = performance.now();
      const reqDurationMs = Math.round(failureTime - reqStartMs);

      if (timedOutFirstByte) {
        // Suspect timeout: hung model or silent throttle -> 10 min cooldown
        useKeyStore.getState().applyCooldown(slot.id, modelPath, 10 * 60 * 1000, 'suspect');
        useKeyStore.getState().recordAttempt({
          time: Date.now(),
          keyLabel: slot.label,
          model: modelClean,
          phase: 'first-byte',
          result: 'suspect timeout',
          durationMs: reqDurationMs,
        });

        const nextAttempt = attemptsToRun[i + 1];
        if (nextAttempt) {
          rotationLine = `${slot.label} · ${modelClean} · timed out -> ${nextAttempt.slot.label}`;
        }
        previousReason = 'First byte timed out';
        lastError = new Error('First byte timed out after 60 s');
        lastFailureDetectedAt = failureTime;
        continue;
      }

      const msg = redactApiKey((reqErr as Error).message || 'Network error', rawKey);
      lastError = new Error(msg);

      if (
        msg.includes('HTTP 400') &&
        !msg.includes('API_KEY_INVALID') &&
        !msg.includes('API key not valid')
      ) {
        throw lastError; // Client error: do not rotate
      }

      if (msg.includes('cancelled')) {
        throw lastError;
      }

      // Network error: do not rotate
      useKeyStore.getState().recordAttempt({
        time: Date.now(),
        keyLabel: slot.label,
        model: modelClean,
        phase: 'upload',
        result: 'network error',
        durationMs: reqDurationMs,
      });

      throw lastError;
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
