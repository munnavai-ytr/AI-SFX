/**
 * Pure REST client for Gemini generateContent and model discovery.
 * - API key strictly in x-goog-api-key header.
 * - Never in URL or exposed in error messages.
 * - Uses generationConfig with thinkingConfig, maxOutputTokens: 4096, and 400-thinking fallback.
 * - Strict timeout, retry, and model fallback chain with 150s total deadline.
 */

const MODELS_CACHE_KEY = 'aiModelsCache';
const SELECTED_MODEL_KEY = 'sfx_ai_selected_model';
const NO_THINKING_KEY = 'no-thinking-config';

export function redactApiKey(text: string, apiKey?: string): string {
  if (!text) return '';
  let cleaned = text;
  if (apiKey && apiKey.length > 5) {
    cleaned = cleaned.replaceAll(apiKey, '[REDACTED]');
  }
  cleaned = cleaned.replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]');
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
    const key = `aiCalls:${getTodayDateString()}`;
    const val = localStorage.getItem(key);
    return val ? parseInt(val, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export function incrementAiCallsToday(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const key = `aiCalls:${getTodayDateString()}`;
    const current = getAiCallsToday();
    const updated = current + 1;
    localStorage.setItem(key, String(updated));
    return updated;
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
 * Discover, filter, and rank available Gemini models from Google AI Studio REST API.
 * Never auto-selects *-pro models.
 */
export async function discoverGeminiModels(
  apiKey: string,
  forceRefresh = false
): Promise<string[]> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) return [];

  // Check 24h cache
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
    } catch {
      // ignore
    }
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
      } catch {
        // ignore
      }
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

  // Cache in localStorage
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

/**
 * Derives thinkingConfig based on model name and no-thinking status.
 */
export function getThinkingConfigForModel(
  model: string
): { thinkingBudget?: number; thinkingLevel?: string } | undefined {
  if (isNoThinkingModel(model)) return undefined;

  const lower = model.toLowerCase();
  if (lower.includes('2.5-flash') || lower.includes('2.5-flash-lite')) {
    return { thinkingBudget: 0 };
  }
  if (lower.includes('gemini-3') || lower.includes('gemini-3.') || lower.includes('3.8-flash') || lower.includes('3.7-flash')) {
    return { thinkingLevel: 'LOW' };
  }

  return undefined;
}

/**
 * Builds the generateContent body object with thinkingConfig & maxOutputTokens: 4096.
 */
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
  attempt: number;
  totalAttempts: number;
  elapsedSeconds: number;
  previousReason?: string;
}

/**
 * Calls Gemini REST generateContent with:
 * - 60s per-request timeout
 * - Timeout does NOT retry same model (moves to next model, max 2 models for timeouts)
 * - Network errors & 5xx retry same model ONCE after 2s
 * - 400/401/403 never retry (except 400 thinking error retries once without thinkingConfig)
 * - Total step deadline 150s: throws "The AI did not answer in time. Check your connection, or try again."
 */
export async function callGeminiGenerateContent(
  apiKey: string,
  body: GeminiGenerateContentRequest,
  options?: {
    preferredModel?: string;
    signal?: AbortSignal;
    onProgress?: (info: GeminiCallProgress) => void;
  }
): Promise<{ text: string; modelUsed: string; attemptsCount: number }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('Gemini API key is required.');
  }

  const stepStartMs = performance.now();
  const TOTAL_STEP_DEADLINE_MS = 150000; // 150s total deadline
  const PER_REQUEST_TIMEOUT_MS = 60000; // 60s request timeout

  // Discover & rank models
  let discovered: string[] = [];
  try {
    discovered = await discoverGeminiModels(cleanKey);
  } catch {
    discovered = ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-2.5-flash'];
  }

  // Filter out *-pro models for auto selection
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

  let totalAttemptsCount = 0;
  let timeoutModelCount = 0;
  let previousReason: string | undefined = undefined;
  let lastError: Error | null = null;

  for (let modelIndex = 0; modelIndex < candidateModels.length; modelIndex++) {
    // Stop if total deadline exceeded
    if (performance.now() - stepStartMs >= TOTAL_STEP_DEADLINE_MS) {
      throw new Error('The AI did not answer in time. Check your connection, or try again.');
    }

    // Stop if 2 models have timed out
    if (timeoutModelCount >= 2) {
      throw new Error(
        previousReason
          ? `AI request failed: ${previousReason}. Check your connection, or try again.`
          : 'The AI did not answer in time. Check your connection, or try again.'
      );
    }

    const rawModelName = candidateModels[modelIndex];
    const modelPath = rawModelName.startsWith('models/') ? rawModelName : `models/${rawModelName}`;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;

    let modelAttempt = 0;
    let thinkingFallbackTried = false;

    while (modelAttempt < 2) {
      modelAttempt++;
      totalAttemptsCount++;

      if (options?.signal?.aborted) {
        throw new Error('Analysis cancelled by user.');
      }

      // Check total deadline before starting request
      if (performance.now() - stepStartMs >= TOTAL_STEP_DEADLINE_MS) {
        throw new Error('The AI did not answer in time. Check your connection, or try again.');
      }

      // Prepare request body with model-specific thinkingConfig
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

      // Per-request 60s timeout controller
      const timeoutController = new AbortController();
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(new Error(`timed out after 60 s`));
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
          attempt: totalAttemptsCount,
          totalAttempts: 3,
          elapsedSeconds: elapsed,
          previousReason,
        });
      }, 300);

      try {
        incrementAiCallsToday();

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': cleanKey,
          },
          body: JSON.stringify(currentBody),
          signal: timeoutController.signal,
        });

        clearInterval(progressTimer);
        clearTimeout(timeoutId);
        if (options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }

        if (response.ok) {
          const json = await response.json();
          const candidateText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!candidateText) {
            throw new Error(`Empty response returned by Gemini model ${modelPath}`);
          }
          return { text: candidateText, modelUsed: modelPath, attemptsCount: totalAttemptsCount };
        }

        // Handle error status
        const status = response.status;
        let errorMessage = `HTTP ${status}`;
        let rawBodyMessage = '';

        try {
          const errBody = await response.json();
          if (errBody?.error?.message) {
            rawBodyMessage = errBody.error.message;
            errorMessage = `HTTP ${status} (${rawBodyMessage})`;
          }
        } catch {
          // ignore
        }

        const safeMessage = redactApiKey(errorMessage, cleanKey);

        // Check for 400 Thinking error fallback
        if (
          status === 400 &&
          !thinkingFallbackTried &&
          /(thinking|thinkingConfig|thinkingLevel|thinkingBudget)/i.test(rawBodyMessage)
        ) {
          markNoThinkingModel(modelPath);
          thinkingFallbackTried = true;
          totalAttemptsCount--; // Do not count as failure attempt
          continue; // Retry immediately without thinkingConfig
        }

        // Non-retryable HTTP 400, 401, 403
        if (status === 400 || status === 401 || status === 403) {
          throw new Error(safeMessage);
        }

        // 404 or 429: break to next model in fallback chain
        if (status === 404 || status === 429) {
          previousReason = `HTTP ${status}`;
          lastError = new Error(safeMessage);
          break;
        }

        // HTTP 5xx: retry same model ONCE after 2s delay
        if (status >= 500 && status < 600) {
          previousReason = `HTTP ${status}`;
          if (modelAttempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
        }

        previousReason = `HTTP ${status}`;
        lastError = new Error(safeMessage);
        break;
      } catch (reqErr) {
        clearInterval(progressTimer);
        clearTimeout(timeoutId);
        if (options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }

        if (options?.signal?.aborted) {
          throw new Error('Analysis cancelled by user.');
        }

        if (timedOut) {
          timeoutModelCount++;
          previousReason = 'timed out after 60 s';
          lastError = new Error('timed out after 60 s');
          // A timeout MUST NOT retry the same model -> break to next model
          break;
        }

        const msg = redactApiKey((reqErr as Error).message || 'Network error', cleanKey);
        lastError = new Error(msg);
        previousReason = msg.includes('HTTP') ? msg : 'Network error';

        if (
          msg.includes('HTTP 400') ||
          msg.includes('HTTP 401') ||
          msg.includes('HTTP 403') ||
          msg.includes('cancelled')
        ) {
          throw lastError;
        }

        // Network error: retry same model ONCE after 2s
        if (modelAttempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        break;
      }
    }
  }

  if (performance.now() - stepStartMs >= TOTAL_STEP_DEADLINE_MS) {
    throw new Error('The AI did not answer in time. Check your connection, or try again.');
  }

  throw lastError || new Error('The AI did not answer in time. Check your connection, or try again.');
}

/**
 * Sends a tiny text-only request ("Reply with OK") to test model latency in Settings.
 */
export async function testAiSpeed(
  apiKey: string,
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

  const res = await callGeminiGenerateContent(apiKey, body, { preferredModel });
  const latencyMs = Math.round(performance.now() - start);
  return { latencyMs, modelUsed: res.modelUsed };
}
