import { detectCuts } from './detect';

export interface VideoFrameAnalysisResult {
  duration: number;
  width: number;
  height: number;
  fps: number | null;
  cuts: { t: number; strength: number }[];
  samples: { t: number; jpeg: Blob }[];
  mode: 'realtime-capture' | 'seek-fallback';
  frameBytes: number;
}

export interface VideoProcessingHandlers {
  onReadProgress?: (progress: number, detail: string) => void;
  onFramesProgress?: (progress: number, detail: string) => void;
  onCutsProgress?: (progress: number, detail: string) => void;
  isCancelled: () => boolean;
}

/**
 * Creates and primes a hidden video element for decoding.
 */
export async function setupPrimedVideo(
  videoBlob: Blob,
  onProgress?: (progress: number, detail: string) => void,
  isCancelled?: () => boolean
): Promise<{ video: HTMLVideoElement; container: HTMLElement; tempUrl: string }> {
  if (typeof document === 'undefined') {
    throw new Error('Video processing requires browser DOM environment.');
  }

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  container.style.width = '2px';
  container.style.height = '2px';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';
  container.style.overflow = 'hidden';
  document.body.appendChild(container);

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.width = '2px';
  video.style.height = '2px';
  container.appendChild(video);

  const tempUrl = URL.createObjectURL(videoBlob);
  video.src = tempUrl;

  onProgress?.(0.2, 'Loading video container & metadata...');

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Video metadata loading timed out.'));
      }
    }, 15000);

    video.onloadedmetadata = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    };

    video.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to read video: ${video.error?.message || 'Unsupported media file'}`));
      }
    };
  });

  if (isCancelled?.()) {
    cleanupVideo(video, container, tempUrl);
    throw new Error('Analysis cancelled by user.');
  }

  // Prime video readyState to at least 2 (HAVE_CURRENT_DATA)
  onProgress?.(0.6, 'Priming video decoder buffer...');
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = Math.min(0.05, Math.max(0, video.duration - 0.05));
    });

    if (video.readyState < 2) {
      try {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          await playPromise;
        }
        video.pause();
      } catch {
        // ignore play rejection during prime
      }
    }
  }

  onProgress?.(1.0, `Video primed (${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s)`);

  return { video, container, tempUrl };
}

export function cleanupVideo(video: HTMLVideoElement, container: HTMLElement, tempUrl: string) {
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // ignore
  }
  if (container.parentNode) {
    container.parentNode.removeChild(container);
  }
  URL.revokeObjectURL(tempUrl);
}

/**
 * Extracts grayscale pixels (32x18) and returns mean absolute difference vs previous frame.
 */
function computeDiff(
  video: HTMLVideoElement,
  canvas32: HTMLCanvasElement,
  ctx32: CanvasRenderingContext2D,
  prevGray: Uint8Array | null
): { diff: number; gray: Uint8Array } {
  ctx32.drawImage(video, 0, 0, 32, 18);
  const imgData = ctx32.getImageData(0, 0, 32, 18).data;
  const gray = new Uint8Array(576);

  let sumDiff = 0;
  for (let i = 0; i < 576; i++) {
    const idx = i * 4;
    // Standard perceptual luminance
    const g = (imgData[idx] * 77 + imgData[idx + 1] * 150 + imgData[idx + 2] * 29) >> 8;
    gray[i] = g;
    if (prevGray) {
      sumDiff += Math.abs(g - prevGray[i]);
    }
  }

  const diff = prevGray ? sumDiff / (576 * 255) : 0;
  return { diff, gray };
}

/**
 * Captures a 384-px wide JPEG frame sample.
 */
function captureSample(
  video: HTMLVideoElement,
  canvas384: HTMLCanvasElement,
  ctx384: CanvasRenderingContext2D
): Promise<Blob> {
  ctx384.drawImage(video, 0, 0, canvas384.width, canvas384.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas384.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode sample JPEG'));
      },
      'image/jpeg',
      0.7
    );
  });
}

/**
 * Processes video frames, cuts, and 1fps sample collection.
 */
export async function processVideoFrames(
  video: HTMLVideoElement,
  handlers: VideoProcessingHandlers
): Promise<VideoFrameAnalysisResult> {
  const duration = video.duration;
  const width = video.videoWidth || 384;
  const height = video.videoHeight || 216;

  // Reusable offscreen canvases
  const canvas32 = document.createElement('canvas');
  canvas32.width = 32;
  canvas32.height = 18;
  const ctx32 = canvas32.getContext('2d', { willReadFrequently: true });

  const canvas384 = document.createElement('canvas');
  canvas384.width = 384;
  canvas384.height = Math.max(1, Math.round(384 * (height / width)));
  const ctx384 = canvas384.getContext('2d');

  if (!ctx32 || !ctx384) {
    throw new Error('Failed to create 2D canvas contexts for video analysis.');
  }

  const diffs: { t: number; d: number }[] = [];
  const samplePromises: { t: number; promise: Promise<Blob> }[] = [];
  let nextSampleTime = 0;
  let prevGray: Uint8Array | null = null;
  let frameCount = 0;

  // Before starting playback/capture, ensure video.currentTime is reset to 0
  video.currentTime = 0;
  await new Promise<void>((res) => {
    const onSeekedZero = () => {
      video.removeEventListener('seeked', onSeekedZero);
      res();
    };
    video.addEventListener('seeked', onSeekedZero, { once: true });
    // Failsafe in case currentTime was already 0 and seeked doesn't fire
    setTimeout(res, 300);
  });

  // Determine if rVFC is supported
  const v = video as unknown as {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const hasRVFC = typeof v.requestVideoFrameCallback === 'function';

  let mode: 'realtime-capture' | 'seek-fallback' = 'realtime-capture';

  if (hasRVFC) {
    try {
      video.playbackRate = 2.0;
      await video.play();

      let lastCallbackTime = performance.now();
      let skipCounter = 0;

      await new Promise<void>((resolve, reject) => {
        let handle = 0;
        let done = false;
        let lastAdvance = performance.now();
        let lastMediaTime = -1;

        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          clearInterval(wd);
          video.removeEventListener('ended', onEnded);
          try {
            if (v.cancelVideoFrameCallback) {
              v.cancelVideoFrameCallback(handle);
            }
          } catch {
            // ignore
          }
          try {
            video.pause();
          } catch {
            // ignore
          }
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        };

        const onEnded = () => finish();
        video.addEventListener('ended', onEnded);

        // Watchdog on its own timer, independent of frame callbacks
        const wd = setInterval(() => {
          if (handlers.isCancelled()) {
            return finish(new Error('Analysis cancelled by user.'));
          }
          const now = performance.now();
          if (video.paused && !video.ended) {
            video.play().catch(() => {});
          }
          if (now - lastAdvance > 3000) {
            if (lastMediaTime >= duration - 0.5) {
              return finish(); // effectively finished
            }
            if (video.playbackRate > 1.5) {
              video.playbackRate = 1.5;
            } else if (video.playbackRate > 1.0) {
              video.playbackRate = 1.0;
            } else {
              return finish(new Error('WATCHDOG_STALLED'));
            }
            lastAdvance = now;
          }
        }, 500);

        const onFrame = (now: number, meta: { mediaTime: number }) => {
          if (done) return;
          if (meta.mediaTime > lastMediaTime) {
            lastMediaTime = meta.mediaTime;
            lastAdvance = now;
          }

          const deltaCallback = (now - lastCallbackTime) / 1000;
          lastCallbackTime = now;

          // Detect skipped frames
          if (deltaCallback > 0.1) {
            skipCounter++;
            if (skipCounter > 5 && video.playbackRate > 1.0) {
              video.playbackRate = Math.max(1.0, video.playbackRate - 0.5);
              skipCounter = 0;
            }
          }

          const mediaTime = meta.mediaTime;

          // Process diff
          const { diff, gray } = computeDiff(video, canvas32, ctx32, prevGray);
          prevGray = gray;
          diffs.push({ t: mediaTime, d: diff });
          frameCount++;

          // Collect 1 fps sample
          if (mediaTime >= nextSampleTime) {
            samplePromises.push({
              t: mediaTime,
              promise: captureSample(video, canvas384, ctx384),
            });
            nextSampleTime = Math.floor(mediaTime) + 1;
          }

          const progress = Math.min(0.99, mediaTime / Math.max(1, duration));
          handlers.onFramesProgress?.(
            progress,
            `Frame ${frameCount.toLocaleString()} (${mediaTime.toFixed(1)} s / ${duration.toFixed(1)} s at ${video.playbackRate}x)`
          );

          if (video.ended || meta.mediaTime >= duration - 0.25) {
            return finish();
          }

          if (v.requestVideoFrameCallback) {
            handle = v.requestVideoFrameCallback(onFrame);
          }
        };

        if (v.requestVideoFrameCallback) {
          handle = v.requestVideoFrameCallback(onFrame);
        }
      });
    } catch (realtimeErr) {
      if (handlers.isCancelled() || (realtimeErr as Error).message === 'Analysis cancelled by user.') {
        throw realtimeErr;
      }
      console.warn('Realtime capture halted or unsupported, switching to seek fallback:', realtimeErr);
      mode = 'seek-fallback';
    }
  } else {
    mode = 'seek-fallback';
  }

  // Seek Fallback mode (4 fps diffs, 1 fps samples)
  if (mode === 'seek-fallback') {
    video.pause();
    handlers.onFramesProgress?.(0, 'Compatibility mode (slower sequential seek)...');

    const stepSec = 0.25; // 4 fps
    let t = 0;
    diffs.length = 0;
    samplePromises.length = 0;
    nextSampleTime = 0;
    prevGray = null;
    frameCount = 0;

    let lastYieldTime = performance.now();

    while (t < duration) {
      if (handlers.isCancelled()) {
        throw new Error('Analysis cancelled by user.');
      }

      // Seek to t
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = t;
      });

      // Wait until video.readyState >= 2 (poll up to 1 s) before reading pixels
      if (video.readyState < 2) {
        const waitStart = performance.now();
        while (video.readyState < 2 && performance.now() - waitStart < 1000) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      // Compute diff
      const { diff, gray } = computeDiff(video, canvas32, ctx32, prevGray);
      prevGray = gray;
      diffs.push({ t, d: diff });
      frameCount++;

      // Collect sample every 1 second
      if (t >= nextSampleTime) {
        samplePromises.push({
          t,
          promise: captureSample(video, canvas384, ctx384),
        });
        nextSampleTime = Math.floor(t) + 1;
      }

      const progress = Math.min(0.99, t / Math.max(1, duration));
      handlers.onFramesProgress?.(
        progress,
        `Compatibility mode: Frame ${frameCount} (${t.toFixed(1)} s / ${duration.toFixed(1)} s)`
      );

      t += stepSec;

      // Yield event loop every ~200ms
      if (performance.now() - lastYieldTime > 200) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYieldTime = performance.now();
      }
    }
  }

  // Await all sample JPEG blobs
  handlers.onFramesProgress?.(0.98, `Finalizing ${samplePromises.length} visual reference frames...`);
  const resolvedBlobs = await Promise.all(samplePromises.map((s) => s.promise));
  const samples = samplePromises.map((s, idx) => ({
    t: s.t,
    jpeg: resolvedBlobs[idx],
  }));

  const frameBytes = samples.reduce((acc, s) => acc + s.jpeg.size, 0);

  // Estimate FPS from median frame spacing
  const spacings: number[] = [];
  for (let i = 1; i < diffs.length; i++) {
    const dt = diffs[i].t - diffs[i - 1].t;
    if (dt > 0.005) {
      spacings.push(dt);
    }
  }
  spacings.sort((a, b) => a - b);
  const medianDt = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 0;
  const fps = medianDt > 0 ? Math.round(1 / medianDt) : null;

  handlers.onFramesProgress?.(1.0, `Processed ${diffs.length.toLocaleString()} frames (${samples.length} sampled, est. ${fps || '—'} fps)`);

  // Step 4: Cuts detection
  handlers.onCutsProgress?.(0.5, `Analyzing ${diffs.length} frame differences for scene boundaries...`);
  const cuts = detectCuts(diffs);
  handlers.onCutsProgress?.(1.0, `Found ${cuts.length} scene cuts`);

  return {
    duration,
    width,
    height,
    fps,
    cuts,
    samples,
    mode,
    frameBytes,
  };
}
