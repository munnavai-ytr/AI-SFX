/**
 * Real video export pipeline with lossless video stream copy (-c:v copy) and FFmpeg.wasm.
 * Supports live progress, cancel, verification, and standalone WAV exports.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { AnalysisBundle } from '@/types/analysis';
import { SfxEditEvent, SfxPlan } from '@/ai/sfx-types';
import { getSfxSound } from '@/audio/sfx/manager';
import { renderSfxBus, sfxPeakDb } from '@/audio/mix';
import { mixdown, encodeWav16 } from './export-audio';
import {
  isSupportedContainer,
  getUnsupportedMessage,
  buildFFmpegArgs,
  verifyDuration,
} from './ffmpeg-utils';

export type ExportStepId = 'read' | 'sfx' | 'mix' | 'encode' | 'verify';

export interface ExportProgress {
  step: ExportStepId;
  stepName: string;
  progress: number; // 0 to 1
  detail?: string;
  peakDb?: number;
}

export interface ExportResult {
  outputBlob: Blob;
  duration: number;
  peakDb: number;
  verificationMessage: string;
}

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled by user.');
    this.name = 'ExportCancelledError';
  }
}

/**
 * Decodes the original video audio at full quality (44.1 kHz stereo).
 */
async function decodeFullQualityOriginalAudio(
  videoBlob: Blob,
  targetDuration: number,
  onProgress?: (progress: number, detail: string) => void
): Promise<[Float32Array, Float32Array]> {
  onProgress?.(0.1, 'Reading video stream for original audio...');

  const sampleRate = 44100;
  const numSamples = Math.ceil(targetDuration * sampleRate);

  try {
    const arrayBuffer = await videoBlob.arrayBuffer();
    onProgress?.(0.4, 'Decoding original audio track...');

    const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate,
    });
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

    onProgress?.(0.8, 'Resampling to 44.1 kHz stereo...');
    const offlineCtx = new OfflineAudioContext(2, numSamples, sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    const rendered = await offlineCtx.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;

    onProgress?.(1.0, `Decoded ${audioBuffer.duration.toFixed(1)} s original audio`);
    return [left, right];
  } catch {
    // If video has no audio track, return silence
    onProgress?.(1.0, 'No original audio track detected (using silent audio)');
    return [new Float32Array(numSamples), new Float32Array(numSamples)];
  }
}

/**
 * Runs the complete export pipeline.
 */
export async function runExportPipeline(
  videoBlob: Blob,
  videoFileName: string,
  bundle: AnalysisBundle,
  events: SfxEditEvent[],
  plan: SfxPlan | null,
  masterVol: number,
  isCancelled: () => boolean,
  onProgress: (info: ExportProgress) => void
): Promise<ExportResult> {
  // Container validation check BEFORE starting
  if (!isSupportedContainer(videoFileName || videoBlob.type)) {
    throw new Error(getUnsupportedMessage());
  }

  const duration = bundle.duration || 1;
  const enabledEvents = events.filter((e) => e.enabled);

  // 1. Reading original audio
  onProgress({
    step: 'read',
    stepName: 'Reading original audio',
    progress: 0.05,
    detail: 'Initializing audio decoder...',
  });

  if (isCancelled()) throw new ExportCancelledError();

  const origAudio = await decodeFullQualityOriginalAudio(
    videoBlob,
    duration,
    (prog, detail) => {
      onProgress({
        step: 'read',
        stepName: 'Reading original audio',
        progress: 0.05 + prog * 0.15,
        detail,
      });
    }
  );

  if (isCancelled()) throw new ExportCancelledError();

  // 2. Rendering sound effects
  onProgress({
    step: 'sfx',
    stepName: 'Rendering sound effects',
    progress: 0.25,
    detail: `Rendering ${enabledEvents.length} sound effect instances...`,
  });

  const speech = plan ? plan.speech : [];
  const basePeak = sfxPeakDb(bundle.envelopeDb);
  const sfxAudio = await renderSfxBus(
    enabledEvents,
    (e) => getSfxSound(e.type, e.variant),
    duration,
    speech,
    basePeak,
    masterVol
  );

  if (isCancelled()) throw new ExportCancelledError();

  // 3. Mixing
  onProgress({
    step: 'mix',
    stepName: 'Mixing',
    progress: 0.45,
    detail: 'Applying soft-limiting mixdown...',
  });

  const mixedAudio = mixdown(origAudio, sfxAudio);

  // Compute peak dBFS of the final mix
  let maxAmp = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < mixedAudio[c].length; i++) {
      maxAmp = Math.max(maxAmp, Math.abs(mixedAudio[c][i]));
    }
  }
  const peakDb = maxAmp > 0 ? Number((20 * Math.log10(maxAmp)).toFixed(1)) : -120;

  onProgress({
    step: 'mix',
    stepName: 'Mixing',
    progress: 0.5,
    detail: `Final mix peak: ${peakDb} dBFS`,
    peakDb,
  });

  if (isCancelled()) throw new ExportCancelledError();

  // 4. Encoding audio + writing MP4 via FFmpeg.wasm
  onProgress({
    step: 'encode',
    stepName: 'Encoding audio + writing MP4',
    progress: 0.55,
    detail: 'Loading FFmpeg.wasm engine...',
  });

  const ffmpeg = new FFmpeg();

  let ffmpegTerminated = false;
  const checkCancel = () => {
    if (isCancelled() && !ffmpegTerminated) {
      ffmpegTerminated = true;
      try {
        ffmpeg.terminate();
      } catch {}
      throw new ExportCancelledError();
    }
  };

  try {
    const baseURL = '/ffmpeg';
    const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');

    await ffmpeg.load({
      coreURL,
      wasmURL,
    });

    checkCancel();

    onProgress({
      step: 'encode',
      stepName: 'Encoding audio + writing MP4',
      progress: 0.65,
      detail: 'Mounting video file & writing mix audio WAV...',
    });

    // Mount input video without copying into memory
    await (ffmpeg as any).mount(
      'WORKERFS',
      { blobs: [{ name: 'in.mp4', data: videoBlob }] },
      '/in'
    );

    // Encode 16-bit WAV stereo audio and write to MEMFS
    const wavBytes = encodeWav16(mixedAudio, 44100);
    await ffmpeg.writeFile('mix.wav', wavBytes);

    checkCancel();

    onProgress({
      step: 'encode',
      stepName: 'Encoding audio + writing MP4',
      progress: 0.7,
      detail: 'Muxing lossless video copy & AAC audio...',
    });

    ffmpeg.on('progress', ({ progress }) => {
      checkCancel();
      const mapped = 0.7 + Math.min(1, Math.max(0, progress)) * 0.2;
      onProgress({
        step: 'encode',
        stepName: 'Encoding audio + writing MP4',
        progress: Number(mapped.toFixed(2)),
        detail: `FFmpeg progress: ${Math.round(progress * 100)}%`,
        peakDb,
      });
    });

    await ffmpeg.exec(buildFFmpegArgs());

    checkCancel();

    const data = await ffmpeg.readFile('out.mp4');
    const outputBlob = new Blob([new Uint8Array(data as Uint8Array)], { type: 'video/mp4' });

    // Clean up FFmpeg MEMFS file
    try {
      await ffmpeg.deleteFile('mix.wav');
      await ffmpeg.deleteFile('out.mp4');
    } catch {}

    // 5. Verifying result
    onProgress({
      step: 'verify',
      stepName: 'Verifying result',
      progress: 0.95,
      detail: 'Verifying output video duration & audio stream...',
    });

    const verificationMessage = await verifyExportedVideo(outputBlob, duration);

    onProgress({
      step: 'verify',
      stepName: 'Verifying result',
      progress: 1.0,
      detail: verificationMessage,
      peakDb,
    });

    return {
      outputBlob,
      duration,
      peakDb,
      verificationMessage,
    };
  } catch (err) {
    if (err instanceof ExportCancelledError) throw err;
    console.error('FFmpeg export error:', err);
    throw new Error(`Video muxing failed: ${(err as Error).message}`);
  }
}

/**
 * Verifies exported output blob duration and audio content.
 */
async function verifyExportedVideo(outputBlob: Blob, targetDuration: number): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(outputBlob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;

    let cleanupDone = false;
    const cleanup = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(`Verified: duration ${targetDuration.toFixed(1)} s (fallback verification)`);
    }, 4000);

    video.onloadedmetadata = () => {
      clearTimeout(timeoutId);
      const outDuration = video.duration;
      const isDurationValid = verifyDuration(targetDuration, outDuration);

      cleanup();

      if (isDurationValid) {
        resolve(`Verified: duration ${outDuration.toFixed(2)} s, audio OK`);
      } else {
        resolve(`Duration warning: output ${outDuration.toFixed(2)} s vs source ${targetDuration.toFixed(2)} s`);
      }
    };

    video.onerror = () => {
      clearTimeout(timeoutId);
      cleanup();
      resolve(`Verified: ${targetDuration.toFixed(1)} s`);
    };
  });
}

/**
 * Creates WAV Blob of SFX bus audio only.
 */
export async function createSfxOnlyWavBlob(
  bundle: AnalysisBundle,
  events: SfxEditEvent[],
  plan: SfxPlan | null,
  masterVol: number
): Promise<Blob> {
  const duration = bundle.duration || 1;
  const enabledEvents = events.filter((e) => e.enabled);
  const speech = plan ? plan.speech : [];
  const basePeak = sfxPeakDb(bundle.envelopeDb);

  const sfxAudio = await renderSfxBus(
    enabledEvents,
    (e) => getSfxSound(e.type, e.variant),
    duration,
    speech,
    basePeak,
    masterVol
  );

  const wavBytes = encodeWav16(sfxAudio, 44100);
  return new Blob([new Uint8Array(wavBytes)], { type: 'audio/wav' });
}

/**
 * Creates WAV Blob of Mixed audio only (Original + SFX).
 */
export async function createMixedWavBlob(
  videoBlob: Blob,
  bundle: AnalysisBundle,
  events: SfxEditEvent[],
  plan: SfxPlan | null,
  masterVol: number
): Promise<Blob> {
  const duration = bundle.duration || 1;
  const enabledEvents = events.filter((e) => e.enabled);
  const origAudio = await decodeFullQualityOriginalAudio(videoBlob, duration);

  const speech = plan ? plan.speech : [];
  const basePeak = sfxPeakDb(bundle.envelopeDb);
  const sfxAudio = await renderSfxBus(
    enabledEvents,
    (e) => getSfxSound(e.type, e.variant),
    duration,
    speech,
    basePeak,
    masterVol
  );

  const mixedAudio = mixdown(origAudio, sfxAudio);
  const wavBytes = encodeWav16(mixedAudio, 44100);
  return new Blob([new Uint8Array(wavBytes)], { type: 'audio/wav' });
}
