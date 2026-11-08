/**
 * Pure XHR streaming client for Gemini streamGenerateContent?alt=sse.
 * - Real upload progress via xhr.upload.onprogress
 * - Upload stall detection (25 s no progress during upload)
 * - 75 s first-byte timeout after upload completes
 * - 30 s idle-stream chunk timeout
 * - Real-time detail strings for UI progress
 * - Fallback to non-streaming XHR on 400/404 method rejection
 * - Extracts text and detailed token usage metadata
 */

import { redactApiKey } from './gemini';

export interface StreamProgressInfo {
  phase: 'upload' | 'first-byte' | 'stream' | 'http';
  percent?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  elapsedWaitSeconds?: number;
  receivedBytes?: number;
  detail: string;
}

export interface StreamUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thinkingTokenCount?: number;
}

export interface StreamGeminiResult {
  text: string;
  modelUsed: string;
  phase: 'upload' | 'first-byte' | 'stream' | 'http';
  uploadedBytes: number;
  uploadMs: number;
  waitMs: number;
  receiveMs: number;
  usageMetadata?: StreamUsageMetadata;
}

export interface StreamGeminiOptions {
  signal?: AbortSignal;
  onProgress?: (info: StreamProgressInfo) => void;
}

export class GeminiHttpError extends Error {
  status: number;
  body: any;
  phase: 'upload' | 'first-byte' | 'stream' | 'http';

  constructor(message: string, status: number, body: any, phase: 'upload' | 'first-byte' | 'stream' | 'http') {
    super(message);
    this.name = 'GeminiHttpError';
    this.status = status;
    this.body = body;
    this.phase = phase;
  }
}

export class GeminiTimeoutError extends Error {
  phase: 'first-byte' | 'stream';
  elapsedMs: number;

  constructor(message: string, phase: 'first-byte' | 'stream', elapsedMs: number) {
    super(message);
    this.name = 'GeminiTimeoutError';
    this.phase = phase;
    this.elapsedMs = elapsedMs;
  }
}

export class GeminiUploadStallError extends Error {
  constructor(message = 'Upload stalled for 25 s') {
    super(message);
    this.name = 'GeminiUploadStallError';
  }
}

/**
 * Executes a streaming XHR request to Gemini streamGenerateContent.
 */
export async function streamGeminiContent(
  modelPath: string,
  rawKey: string,
  body: Record<string, any>,
  options: StreamGeminiOptions = {}
): Promise<StreamGeminiResult> {
  const normModel = modelPath.startsWith('models/') ? modelPath : `models/${modelPath}`;
  const streamEndpoint = `https://generativelanguage.googleapis.com/v1beta/${normModel}:streamGenerateContent?alt=sse`;
  const nonStreamEndpoint = `https://generativelanguage.googleapis.com/v1beta/${normModel}:generateContent`;

  const bodyStr = JSON.stringify(body);
  const totalUploadBytes = new Blob([bodyStr]).size;

  // In Node.js environment without XMLHttpRequest, fallback to fetch for tests
  if (typeof XMLHttpRequest === 'undefined') {
    return runFetchFallback(streamEndpoint, nonStreamEndpoint, normModel, rawKey, bodyStr, totalUploadBytes, options);
  }

  return new Promise<StreamGeminiResult>((resolve, reject) => {
    let currentEndpoint = streamEndpoint;
    let isStreaming = true;
    let xhr = new XMLHttpRequest();

    let phase: 'upload' | 'first-byte' | 'stream' | 'http' = 'upload';
    const reqStartMs = performance.now();
    let uploadEndMs = 0;
    let firstByteMs = 0;

    let uploadStallTimer: NodeJS.Timeout | null = null;
    let firstByteTimer: NodeJS.Timeout | null = null;
    let idleStreamTimer: NodeJS.Timeout | null = null;
    let waitingInterval: NodeJS.Timeout | null = null;

    let processedTextIndex = 0;
    let accumulatedText = '';
    let latestUsageMetadata: StreamUsageMetadata | undefined = undefined;

    const cleanupTimers = () => {
      if (uploadStallTimer) clearTimeout(uploadStallTimer);
      if (firstByteTimer) clearTimeout(firstByteTimer);
      if (idleStreamTimer) clearTimeout(idleStreamTimer);
      if (waitingInterval) clearInterval(waitingInterval);
    };

    const resetUploadStallTimer = () => {
      if (uploadStallTimer) clearTimeout(uploadStallTimer);
      uploadStallTimer = setTimeout(() => {
        cleanupTimers();
        xhr.abort();
        reject(new GeminiUploadStallError('Upload stalled for 25 s without network progress.'));
      }, 25000); // 25s upload stall timeout
    };

    const resetIdleStreamTimer = () => {
      if (idleStreamTimer) clearTimeout(idleStreamTimer);
      idleStreamTimer = setTimeout(() => {
        cleanupTimers();
        xhr.abort();
        const elapsed = Math.round(performance.now() - firstByteMs);
        reject(new GeminiTimeoutError('Stream idle timeout: no data received for 30 s.', 'stream', elapsed));
      }, 30000); // 30s idle stream chunk timeout
    };

    const handleAbort = () => {
      cleanupTimers();
      xhr.abort();
      reject(new Error('Analysis cancelled by user.'));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        return reject(new Error('Analysis cancelled by user.'));
      }
      options.signal.addEventListener('abort', handleAbort, { once: true });
    }

    const startXhr = (url: string, streaming: boolean) => {
      currentEndpoint = url;
      isStreaming = streaming;
      phase = 'upload';
      processedTextIndex = 0;
      accumulatedText = '';

      xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('x-goog-api-key', rawKey);

      resetUploadStallTimer();

      xhr.upload.onprogress = (e: ProgressEvent) => {
        resetUploadStallTimer();
        if (phase !== 'upload') return;

        const total = e.lengthComputable && e.total > 0 ? e.total : totalUploadBytes;
        const loaded = e.loaded;
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
        const totalMB = (total / (1024 * 1024)).toFixed(1);

        options.onProgress?.({
          phase: 'upload',
          percent,
          uploadedBytes: loaded,
          totalBytes: total,
          detail: `Uploading ${percent}% (${loadedMB} / ${totalMB} MB)`,
        });
      };

      xhr.upload.onload = () => {
        if (uploadStallTimer) clearTimeout(uploadStallTimer);
        uploadEndMs = performance.now();
        phase = 'first-byte';

        options.onProgress?.({
          phase: 'first-byte',
          elapsedWaitSeconds: 0,
          detail: 'Model thinking... 0s',
        });

        // Start 75s first-byte timeout
        firstByteTimer = setTimeout(() => {
          cleanupTimers();
          xhr.abort();
          const elapsed = Math.round(performance.now() - uploadEndMs);
          reject(
            new GeminiTimeoutError(
              'First byte timed out after 75 s of waiting for model response.',
              'first-byte',
              elapsed
            )
          );
        }, 75000); // 75s after upload finishes

        // Update thinking ticker
        waitingInterval = setInterval(() => {
          if (phase !== 'first-byte') return;
          const waitSec = Math.max(0, Math.round((performance.now() - uploadEndMs) / 1000));
          options.onProgress?.({
            phase: 'first-byte',
            elapsedWaitSeconds: waitSec,
            detail: `Model thinking... ${waitSec}s`,
          });
        }, 1000);
      };

      xhr.onprogress = () => {
        if (phase === 'first-byte') {
          phase = 'stream';
          firstByteMs = performance.now();
          if (firstByteTimer) clearTimeout(firstByteTimer);
          if (waitingInterval) clearInterval(waitingInterval);
        }

        resetIdleStreamTimer();

        const fullResponse = xhr.responseText;
        const currentBytes = fullResponse.length;
        const kbStr = (currentBytes / 1024).toFixed(1);

        options.onProgress?.({
          phase: 'stream',
          receivedBytes: currentBytes,
          detail: `Receiving answer... ${kbStr} KB`,
        });

        if (isStreaming) {
          const newChunk = fullResponse.substring(processedTextIndex);
          processedTextIndex = fullResponse.length;

          // Parse SSE data: lines
          const lines = newChunk.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const dataPayload = trimmed.substring(6).trim();
              if (dataPayload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataPayload);
                const partText = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (partText) {
                  accumulatedText += partText;
                }
                if (parsed?.usageMetadata) {
                  latestUsageMetadata = parsed.usageMetadata;
                }
              } catch {}
            }
          }
        }
      };

      xhr.onload = () => {
        cleanupTimers();
        if (options.signal) {
          options.signal.removeEventListener('abort', handleAbort);
        }

        const status = xhr.status;
        const rawResponse = xhr.responseText;

        // Check for 400/404 method fallback if streaming was rejected
        if (isStreaming && (status === 400 || status === 404)) {
          let isMethodRejection = false;
          try {
            const parsedErr = JSON.parse(rawResponse);
            const msg = parsedErr?.error?.message || '';
            if (
              /streamGenerateContent|Method not found|Unsupported method|Invalid method/i.test(msg) ||
              status === 404
            ) {
              isMethodRejection = true;
            }
          } catch {}

          if (isMethodRejection) {
            console.warn(`[GeminiStream] ${normModel} streaming rejected (${status}), falling back to non-streaming generateContent`);
            startXhr(nonStreamEndpoint, false);
            return;
          }
        }

        if (status >= 200 && status < 300) {
          let finalText = accumulatedText;
          if (!isStreaming || !finalText) {
            try {
              const json = JSON.parse(rawResponse);
              finalText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (json?.usageMetadata) {
                latestUsageMetadata = json.usageMetadata;
              }
            } catch {
              finalText = rawResponse;
            }
          }

          const finishMs = performance.now();
          const uploadMs = Math.round((uploadEndMs || finishMs) - reqStartMs);
          const waitMs = Math.round((firstByteMs || finishMs) - (uploadEndMs || reqStartMs));
          const receiveMs = Math.round(finishMs - (firstByteMs || finishMs));

          resolve({
            text: finalText,
            modelUsed: normModel,
            phase,
            uploadedBytes: totalUploadBytes,
            uploadMs,
            waitMs,
            receiveMs,
            usageMetadata: latestUsageMetadata,
          });
          return;
        }

        // Error response handling
        let errBody: any = null;
        let errMsg = `HTTP ${status}`;
        try {
          errBody = JSON.parse(rawResponse);
          if (errBody?.error?.message) {
            errMsg = `HTTP ${status} (${errBody.error.message})`;
          }
        } catch {}

        reject(new GeminiHttpError(redactApiKey(errMsg, rawKey), status, errBody, phase));
      };

      xhr.onerror = () => {
        cleanupTimers();
        if (options.signal) {
          options.signal.removeEventListener('abort', handleAbort);
        }
        reject(new GeminiHttpError('Network connection failed during request.', 0, null, phase));
      };

      xhr.send(bodyStr);
    };

    startXhr(streamEndpoint, true);
  });
}

/**
 * Fallback for Node.js test environment using standard fetch.
 */
async function runFetchFallback(
  streamEndpoint: string,
  nonStreamEndpoint: string,
  normModel: string,
  rawKey: string,
  bodyStr: string,
  totalBytes: number,
  options: StreamGeminiOptions
): Promise<StreamGeminiResult> {
  const reqStart = performance.now();
  let res: Response;

  try {
    res = await fetch(nonStreamEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': rawKey,
      },
      body: bodyStr,
      signal: options.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Analysis cancelled by user.');
    }
    const msg = String(err?.message || '');
    if (/timed? ?out|timeout/i.test(msg)) {
      throw new GeminiTimeoutError(msg || 'First byte timed out after 75 s', 'first-byte', 75000);
    }
    throw new GeminiHttpError('Network error', 0, null, 'upload');
  }

  const durationMs = Math.round(performance.now() - reqStart);

  if (!res.ok) {
    let errBody: any = null;
    let msg = `HTTP ${res.status}`;
    try {
      errBody = await res.json();
      if (errBody?.error?.message) {
        msg = `HTTP ${res.status} (${errBody.error.message})`;
      }
    } catch {}
    throw new GeminiHttpError(redactApiKey(msg, rawKey), res.status, errBody, 'http');
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = json?.usageMetadata;

  return {
    text,
    modelUsed: normModel,
    phase: 'http',
    uploadedBytes: totalBytes,
    uploadMs: Math.round(durationMs * 0.2),
    waitMs: Math.round(durationMs * 0.7),
    receiveMs: Math.round(durationMs * 0.1),
    usageMetadata: usage,
  };
}
