import { AnalysisBundle } from '@/types/analysis';
import {
  ProjectMetadata,
  getVideoBlob,
  getAnalysisBundle,
  saveAnalysisBundle,
} from '@/lib/storage';
import { useAnalysisStore } from '@/stores/use-analysis-store';
import { useAppStore } from '@/stores/use-app-store';
import { setupPrimedVideo, cleanupVideo, processVideoFrames } from './video';
import { processAudioTrack, AudioAnalysisResult } from './audio';
import { packAnalysisBundle } from './pack';
import { SfxPlan, saveSfxPlan, getSfxPlan } from '@/ai/sfx-types';
import { runAiDirector } from '@/ai/director';

export const ANALYSIS_PIPELINE_STEPS = [
  { id: 'read', label: 'Reading video' },
  { id: 'audio', label: 'Listening to audio' },
  { id: 'frames', label: 'Watching frames' },
  { id: 'cuts', label: 'Finding scene cuts' },
  { id: 'sound', label: 'Finding sound moments' },
  { id: 'pack', label: 'Preparing for AI' },
  { id: 'ai', label: 'Choosing sound effects (AI)' },
  { id: 'place', label: 'Placing on timeline' },
];

export interface AnalysisEngineResult {
  bundle: AnalysisBundle;
  plan: SfxPlan;
}

export async function runAnalysisEngine(
  project: ProjectMetadata,
  options?: {
    forceReanalyze?: boolean;
    forceAiOnly?: boolean;
    apiKey?: string;
    preferredModel?: string;
  }
): Promise<AnalysisEngineResult | null> {
  const store = useAnalysisStore.getState();
  const fileKey = `${project.size}_${project.lastModified || project.createdAt}`;
  const apiKey = options?.apiKey || useAppStore.getState().apiKey;

  if (!apiKey || !apiKey.trim()) {
    throw new Error('Gemini API key is required. Please enter and test your key in Settings.');
  }

  // Always start the full pipeline
  store.startRun(ANALYSIS_PIPELINE_STEPS);

  const abortController = new AbortController();
  const unsubscribeCancel = useAnalysisStore.subscribe((state) => {
    if (state.cancelRequested) {
      abortController.abort();
    }
  });

  const isCancelled = () =>
    useAnalysisStore.getState().cancelRequested || abortController.signal.aborted;

  const startTime = performance.now();
  let bundle: AnalysisBundle | null = null;
  let primedVideoData: { video: HTMLVideoElement; container: HTMLElement; tempUrl: string } | null =
    null;

  try {
    // ----------------------------------------------------
    // CHECK FOR EXISTING SAVED ANALYSIS BUNDLE
    // ----------------------------------------------------
    if (!options?.forceReanalyze) {
      const existingBundle = await getAnalysisBundle(project.id);
      if (existingBundle && existingBundle.fileKey === fileKey) {
        bundle = existingBundle;
        const now = Date.now();
        // Mark steps 1-6 as loaded from saved analysis
        const preSteps = ['read', 'audio', 'frames', 'cuts', 'sound', 'pack'];
        for (const sid of preSteps) {
          store.setStep(sid, {
            status: 'done',
            startedAt: now,
            endedAt: now,
            progress: 1.0,
            detail: 'Loaded saved analysis',
          });
        }
      }
    }

    // ----------------------------------------------------
    // RUN STEPS 1-6 IF NO VALID BUNDLE
    // ----------------------------------------------------
    if (!bundle) {
      // 1. Step: READ
      store.setStep('read', {
        status: 'running',
        startedAt: Date.now(),
        error: undefined,
      });

      const videoBlob = await getVideoBlob(project.id);
      if (!videoBlob) {
        throw new Error('Video file was not found in browser IndexedDB.');
      }

      if (isCancelled()) throw new Error('Analysis cancelled by user.');

      primedVideoData = await setupPrimedVideo(
        videoBlob,
        (progress, detail) => {
          store.setStep('read', { progress, detail });
        },
        isCancelled
      );

      store.setStep('read', {
        status: 'done',
        endedAt: Date.now(),
        progress: 1.0,
        detail: `Video primed (${primedVideoData.video.videoWidth}x${primedVideoData.video.videoHeight}, ${primedVideoData.video.duration.toFixed(1)}s)`,
      });

      // 2. Step: AUDIO
      if (isCancelled()) throw new Error('Analysis cancelled by user.');

      store.setStep('audio', {
        status: 'running',
        startedAt: Date.now(),
        error: undefined,
      });

      const audioResult: AudioAnalysisResult = await processAudioTrack(
        videoBlob,
        primedVideoData.video.duration,
        (progress, detail) => {
          store.setStep('audio', { progress, detail });
        }
      );

      if (!audioResult.hasAudio) {
        store.setStep('audio', {
          status: 'skipped',
          endedAt: Date.now(),
          detail: audioResult.skipReason || 'No audio track detected in video file.',
        });
      } else {
        store.setStep('audio', {
          status: 'done',
          endedAt: Date.now(),
          progress: 1.0,
          detail: `Decoded ${audioResult.decodedDurationSeconds?.toFixed(1) || primedVideoData.video.duration.toFixed(1)} s audio (16 kHz mono WAV: ${(audioResult.audioBytes / 1024).toFixed(1)} KB)`,
        });
      }

      // 3 & 4. Steps: FRAMES & CUTS
      if (isCancelled()) throw new Error('Analysis cancelled by user.');

      store.setStep('frames', {
        status: 'running',
        startedAt: Date.now(),
        error: undefined,
      });
      store.setStep('cuts', {
        status: 'running',
        startedAt: Date.now(),
        detail: 'Observing frame difference stream...',
        error: undefined,
      });

      const frameAnalysisResult = await processVideoFrames(primedVideoData.video, {
        onFramesProgress: (progress, detail) => {
          store.setStep('frames', { progress, detail });
        },
        onCutsProgress: (progress, detail) => {
          store.setStep('cuts', { progress, detail });
        },
        isCancelled,
      });

      store.setStep('frames', {
        status: 'done',
        endedAt: Date.now(),
        progress: 1.0,
        detail: `Sampled ${frameAnalysisResult.samples.length} frames at 1 fps (${frameAnalysisResult.mode})`,
      });

      store.setStep('cuts', {
        status: 'done',
        endedAt: Date.now(),
        progress: 1.0,
        detail: `Detected ${frameAnalysisResult.cuts.length} scene cuts`,
      });

      // 5. Step: SOUND
      store.setStep('sound', {
        status: audioResult.hasAudio ? 'running' : 'skipped',
        startedAt: Date.now(),
        error: undefined,
      });

      if (audioResult.hasAudio) {
        if (isCancelled()) throw new Error('Analysis cancelled by user.');

        store.setStep('sound', {
          status: 'done',
          endedAt: Date.now(),
          progress: 1.0,
          detail: `Identified ${audioResult.transients.length} transients and ${audioResult.quietGaps.length} quiet gaps`,
        });
      } else {
        store.setStep('sound', {
          status: 'skipped',
          endedAt: Date.now(),
          detail: 'Skipped: Video has no decodable audio track',
        });
      }

      // 6. Step: PACK
      if (isCancelled()) throw new Error('Analysis cancelled by user.');

      store.setStep('pack', {
        status: 'running',
        startedAt: Date.now(),
        error: undefined,
      });

      const tookMs = Math.round(performance.now() - startTime);

      bundle = await packAnalysisBundle({
        projectId: project.id,
        fileKey,
        createdAt: Date.now(),
        duration: primedVideoData.video.duration,
        width: primedVideoData.video.videoWidth || 384,
        height: primedVideoData.video.videoHeight || 216,
        fps: frameAnalysisResult.fps,
        hasAudio: audioResult.hasAudio,
        audioWav16k: audioResult.audioWav16k,
        envelopeDb: audioResult.envelopeDb,
        transients: audioResult.transients,
        quietGaps: audioResult.quietGaps,
        cuts: frameAnalysisResult.cuts,
        samples: frameAnalysisResult.samples,
        mode: frameAnalysisResult.mode,
        tookMs,
        onProgress: (progress, detail) => {
          store.setStep('pack', { progress, detail });
        },
      });

      // Save bundle to IndexedDB
      await saveAnalysisBundle(bundle);

      store.setStep('pack', {
        status: 'done',
        endedAt: Date.now(),
        progress: 1.0,
        detail: `Analysis saved (${bundle.stats.payloadMB} MB package in ${(tookMs / 1000).toFixed(1)}s)`,
      });

      // Clean up primed video immediately after frames are extracted
      cleanupVideo(primedVideoData.video, primedVideoData.container, primedVideoData.tempUrl);
      primedVideoData = null;
    }

    // ----------------------------------------------------
    // CHECK FOR EXISTING SFX PLAN FOR THIS BUNDLE
    // ----------------------------------------------------
    if (!options?.forceReanalyze && !options?.forceAiOnly) {
      const existingPlan = await getSfxPlan(project.id);
      if (existingPlan && existingPlan.bundleCreatedAt === bundle.createdAt) {
        const now = Date.now();
        store.setStep('ai', {
          status: 'done',
          startedAt: now,
          endedAt: now,
          progress: 1.0,
          detail: 'Loaded saved plan',
        });
        store.setStep('place', {
          status: 'done',
          startedAt: now,
          endedAt: now,
          progress: 1.0,
          detail: 'Loaded saved plan',
        });
        store.finish();
        return { bundle, plan: existingPlan };
      }
    }

    // ----------------------------------------------------
    // STEP 7: AI DIRECTOR
    // ----------------------------------------------------
    if (isCancelled()) throw new Error('Analysis cancelled by user.');

    store.setStep('ai', {
      status: 'running',
      startedAt: Date.now(),
      detail: 'Connecting to Gemini...',
      error: undefined,
    });

    const directorResult = await runAiDirector(bundle, {
      apiKey,
      preferredModel: options?.preferredModel,
      signal: abortController.signal,
      onProgress: (detail) => {
        store.setStep('ai', { detail });
      },
    });

    store.setStep('ai', {
      status: 'done',
      endedAt: Date.now(),
      progress: 1.0,
      detail: `Received ${directorResult.plan.candidates.length} candidate events (${directorResult.plan.model})`,
    });

    // ----------------------------------------------------
    // STEP 8: PLACE ON TIMELINE
    // ----------------------------------------------------
    if (isCancelled()) throw new Error('Analysis cancelled by user.');

    store.setStep('place', {
      status: 'running',
      startedAt: Date.now(),
      detail: 'Snapping events to cuts & transients...',
      error: undefined,
    });

    // Save plan to IndexedDB
    await saveSfxPlan(directorResult.plan);

    const placeDetail = `Snapped ${directorResult.snappedCount.cuts} to cuts, ${directorResult.snappedCount.transients} to audio spikes; removed ${directorResult.removedCount}`;

    store.setStep('place', {
      status: 'done',
      endedAt: Date.now(),
      progress: 1.0,
      detail: placeDetail,
    });

    store.finish();
    return {
      bundle,
      plan: directorResult.plan,
    };
  } catch (err) {
    const isCancel =
      (err as Error)?.message === 'Analysis cancelled by user.' ||
      useAnalysisStore.getState().cancelRequested ||
      abortController.signal.aborted;

    const errorMsg = (err as Error)?.message || 'Unknown analysis error';

    // Mark EVERY step whose status is 'running'
    const currentSteps = useAnalysisStore.getState().steps;
    for (const step of currentSteps) {
      if (step.status === 'running') {
        if (isCancel) {
          store.setStep(step.id, {
            status: 'skipped',
            endedAt: Date.now(),
            detail: 'Cancelled',
          });
        } else {
          store.setStep(step.id, {
            status: 'failed',
            endedAt: Date.now(),
            error: errorMsg,
          });
        }
      }
    }

    store.finish();

    if (isCancel) {
      return null;
    }

    throw err;
  } finally {
    unsubscribeCancel();
    if (primedVideoData) {
      cleanupVideo(primedVideoData.video, primedVideoData.container, primedVideoData.tempUrl);
    }
  }
}
