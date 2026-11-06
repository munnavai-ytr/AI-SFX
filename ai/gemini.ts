/**
 * Pure REST client for Gemini generateContent and model discovery.
 * - API key strictly in x-goog-api-key header.
 * - Never in URL or exposed in error messages.
 * - Uses generationConfig (NOT config).
 * - Automatic model discovery, ranking, fallback chain, and 24h caching.
 */

const MODELS_CACHE_KEY = 'aiModelsCache';
const SELECTED_MODEL_KEY = 'sfx_ai_selected_model';

export function redactApiKey(text: string, apiKey?: string): string {
  if (!text) return '';
  let cleaned = text;
  if (apiKey && apiKey.length > 5) {
    cleaned = cleaned.replaceAll(apiKey, '[REDACTED]');
  }
  // Redact any Google API key patterns (AIzaSy...)
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

interface DiscoveredModelRaw {
  name: string;
  supportedGenerationMethods?: string[];
  displayName?: string;
  description?: string;
}

export function rankGeminiModels(models: string[]): string[] {
  return [...models].sort((a, b) => {
    // 1. Version parse (gemini-(\d+(\.\d+)?))
    const vMatchA = a.match(/gemini-(\d+(\.\d+)?)/i);
    const vMatchB = b.match(/gemini-(\d+(\.\d+)?)/i);
    const vA = vMatchA ? parseFloat(vMatchA[1]) : 0;
    const vB = vMatchB ? parseFloat(vMatchB[1]) : 0;
    if (vB !== vA) return vB - vA; // Higher version first

    // 2. Tier ranking: flash (3) > flash-lite (2) > pro (1) > other (0)
    const getTier = (name: string) => {
      const lower = name.toLowerCase();
      if (lower.includes('flash-lite')) return 2;
      if (lower.includes('flash')) return 3;
      if (lower.includes('pro')) return 1;
      return 0;
    };
    const tierA = getTier(a);
    const tierB = getTier(b);
    if (tierB !== tierA) return tierB - tierA;

    // 3. Stability: prefer stable over preview / exp
    const isPreviewA = /preview|exp|experimental/i.test(a);
    const isPreviewB = /preview|exp|experimental/i.test(b);
    if (isPreviewA !== isPreviewB) return isPreviewA ? 1 : -1;

    return a.localeCompare(b);
  });
}

/**
 * Discover, filter, and rank available Gemini models from Google AI Studio REST API.
 * Caches in localStorage for 24h.
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
      // ignore cache read failure
    }
  }

  const allModels: DiscoveredModelRaw[] = [];
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

  // Filter:
  // 1. supportedGenerationMethods includes generateContent
  // 2. name matches /gemini/i
  // 3. NOT matching /(embedding|tts|image|live|audio-dialog|robotics|computer-use|learnlm|gemma|aqa)/i
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
  };
}

/**
 * Builds the generateContent body object.
 * Strictly uses generationConfig (NOT config).
 */
export function buildGeminiGenerateContentBody(
  parts: GeminiPart[],
  schema: Record<string, any>,
  temperature = 0.2
): GeminiGenerateContentRequest {
  return {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };
}

export interface GeminiCallProgress {
  model: string;
  attempt: number;
  elapsedSeconds: number;
}

/**
 * Calls Gemini REST generateContent with:
 * - Header-only API key (x-goog-api-key)
 * - 90s AbortController timeout & cancellation hook
 * - Fallback chain on 404/429 to next 2 ranked models
 * - 5xx retry once with 2s delay / retryDelay
 * - Non-retryable 400/401/403 errors with key redacted
 * - Daily call counter increment
 */
export async function callGeminiGenerateContent(
  apiKey: string,
  body: GeminiGenerateContentRequest,
  options?: {
    preferredModel?: string;
    signal?: AbortSignal;
    onProgress?: (info: GeminiCallProgress) => void;
  }
): Promise<{ text: string; modelUsed: string }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('Gemini API key is required.');
  }

  // Determine ranked candidate models
  let discovered: string[] = [];
  try {
    discovered = await discoverGeminiModels(cleanKey);
  } catch {
    // If discovery failed, fall back to default stable aliases
    discovered = ['models/gemini-2.5-flash', 'models/gemini-2.0-flash', 'models/gemini-1.5-flash'];
  }

  if (discovered.length === 0) {
    discovered = ['models/gemini-2.5-flash', 'models/gemini-2.0-flash', 'models/gemini-1.5-flash'];
  }

  const userModel = options?.preferredModel && options.preferredModel !== 'auto'
    ? options.preferredModel
    : getSelectedModel();

  let targetModels: string[] = [];
  if (userModel && userModel !== 'auto') {
    targetModels = [userModel, ...discovered.filter((m) => m !== userModel)];
  } else {
    targetModels = discovered;
  }

  // Model fallback chain: try initial model, then next 2 models on 404 or 429
  const modelsToAttempt = targetModels.slice(0, 3);
  let lastError: Error | null = null;

  for (let modelIndex = 0; modelIndex < modelsToAttempt.length; modelIndex++) {
    const rawModelName = modelsToAttempt[modelIndex];
    // Normalize model path (ensure starts with models/ if needed, or stripped)
    const modelPath = rawModelName.startsWith('models/') ? rawModelName : `models/${rawModelName}`;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;

    // Try current model (allowing 1 retry on 5xx)
    let modelAttempts = 0;
    while (modelAttempts < 2) {
      modelAttempts++;

      if (options?.signal?.aborted) {
        throw new Error('Analysis cancelled by user.');
      }

      // 90 second timeout controller
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => {
        timeoutController.abort(new Error('Gemini API request timed out after 90 seconds.'));
      }, 90000);

      const abortHandler = () => {
        timeoutController.abort(new Error('Analysis cancelled by user.'));
      };
      if (options?.signal) {
        options.signal.addEventListener('abort', abortHandler);
      }

      const startMs = performance.now();
      const progressTimer = setInterval(() => {
        const elapsed = Math.round((performance.now() - startMs) / 1000);
        options?.onProgress?.({
          model: modelPath,
          attempt: modelAttempts,
          elapsedSeconds: elapsed,
        });
      }, 500);

      try {
        // Increment daily call counter before each real generateContent request
        incrementAiCallsToday();

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': cleanKey,
          },
          body: JSON.stringify(body),
          signal: timeoutController.signal,
        });

        clearInterval(progressTimer);
        clearTimeout(timeoutId);
        if (options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }

        if (response.ok) {
          const json = await response.json();
          const candidateText =
            json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!candidateText) {
            throw new Error(`Empty response candidates returned by Gemini model ${modelPath}`);
          }
          return { text: candidateText, modelUsed: modelPath };
        }

        // Handle error responses
        const status = response.status;
        let errorMessage = `HTTP ${status}: ${response.statusText}`;
        let retryDelaySeconds = 2;

        try {
          const errBody = await response.json();
          if (errBody?.error?.message) {
            errorMessage = `HTTP ${status} (${errBody.error.message})`;
          }
          // Check for retryDelay in error details
          if (Array.isArray(errBody?.error?.details)) {
            for (const d of errBody.error.details) {
              if (typeof d?.retryDelay === 'string') {
                const s = parseFloat(d.retryDelay);
                if (!isNaN(s) && s > 0) retryDelaySeconds = s;
              }
            }
          }
        } catch {
          // ignore json parse error
        }

        const safeMessage = redactApiKey(errorMessage, cleanKey);

        // Never retry 400, 401, 403 - throw immediately
        if (status === 400 || status === 401 || status === 403) {
          throw new Error(safeMessage);
        }

        // On 404 or 429, break to try the next model in the fallback chain
        if (status === 404 || status === 429) {
          lastError = new Error(`${safeMessage} on model ${modelPath}`);
          break; // break the modelAttempts while loop to try next model
        }

        // On 5xx, retry the same model once after delay
        if (status >= 500 && status < 600 && modelAttempts < 2) {
          await new Promise((resolve) => setTimeout(resolve, retryDelaySeconds * 1000));
          continue;
        }

        // Any other non-ok status
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

        const msg = redactApiKey((reqErr as Error).message || 'Network error', cleanKey);
        lastError = new Error(msg);

        // If it was an immediate non-retryable error, rethrow
        if (
          msg.includes('HTTP 400') ||
          msg.includes('HTTP 401') ||
          msg.includes('HTTP 403') ||
          msg.includes('cancelled')
        ) {
          throw lastError;
        }

        // If network error on first attempt, retry once after 2s
        if (modelAttempts < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error('All Gemini candidate models failed to respond.');
}
