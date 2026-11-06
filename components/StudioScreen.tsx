'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { getVideoBlob, getAnalysisBundle, deleteAnalysisBundle } from '@/lib/storage';
import { formatDuration, formatBytes } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { AnalysisBundle } from '@/types/analysis';
import { AnalysisView } from '@/components/AnalysisView';
import { runAnalysisEngine } from '@/analysis/engine';
import { useAnalysisStore } from '@/stores/use-analysis-store';
import {
  ArrowLeft,
  Settings,
  Sparkles,
  AlertCircle,
  Loader2,
  RefreshCw,
  Film,
  CheckCircle2,
  Cpu,
  Layers,
  Volume2,
  VolumeX,
} from 'lucide-react';

export function StudioScreen() {
  const {
    activeProjectId,
    projects,
    setScreen,
    openSettings,
    apiKey,
    keyTestState,
    retryProject,
  } = useAppStore();

  const { showToast } = useToast();
  const [videoObjectUrl, setVideoObjectUrl] = useState<string | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<AnalysisBundle | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeUrlRef = useRef<string | null>(null);

  const project = projects.find((p) => p.id === activeProjectId);
  const isLoadingBlob = Boolean(activeProjectId && loadedProjectId !== activeProjectId);

  // Load analysis bundle from IndexedDB asynchronously
  useEffect(() => {
    let isCancelled = false;

    if (!activeProjectId) {
      return;
    }

    getAnalysisBundle(activeProjectId)
      .then((stored) => {
        if (!isCancelled) {
          setBundle(stored);
        }
      })
      .catch((err) => {
        console.error('Failed to load analysis bundle:', err);
      });

    return () => {
      isCancelled = true;
    };
  }, [activeProjectId]);

  // Load video blob from IndexedDB and create runtime object URL
  useEffect(() => {
    let isCancelled = false;

    if (!activeProjectId) {
      return;
    }

    getVideoBlob(activeProjectId)
      .then((blob) => {
        if (isCancelled) return;
        if (blob) {
          const url = URL.createObjectURL(blob);
          activeUrlRef.current = url;
          setVideoObjectUrl(url);
        } else {
          setVideoObjectUrl(null);
        }
      })
      .catch((err) => {
        console.error('Failed to load video blob:', err);
      })
      .finally(() => {
        if (!isCancelled) {
          setLoadedProjectId(activeProjectId);
        }
      });

    return () => {
      isCancelled = true;
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
    };
  }, [activeProjectId]);

  if (!project) {
    return (
      <div className="min-h-screen bg-[var(--ink)] text-[var(--text)] flex flex-col items-center justify-center p-6 text-center">
        <p className="text-[var(--text-2)] mb-4">Project not found or was deleted.</p>
        <button
          type="button"
          onClick={() => setScreen('home')}
          className="px-5 py-2.5 rounded-[10px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-sm font-medium hover:border-[var(--volt)] transition-colors min-h-[44px]"
        >
          Return to Projects
        </button>
      </div>
    );
  }

  // Determine disabled state and reason for the Analyze button
  const isVideoReady = project.status === 'ready';
  const hasKey = Boolean(apiKey.trim());
  const isKeyTestedAndValid = keyTestState.tested && keyTestState.valid;

  let disabledReason: string | null = null;
  if (project.status === 'saving') {
    disabledReason = 'Saving video...';
  } else if (project.status === 'probing') {
    disabledReason = 'Reading video info...';
  } else if (project.status === 'failed') {
    disabledReason = project.error || 'Video failed to process';
  } else if (!hasKey) {
    disabledReason = 'Add your Gemini API key in Settings';
  } else if (!isKeyTestedAndValid) {
    disabledReason = 'Test your Gemini API key in Settings';
  }

  const isAnalyzeEnabled = isVideoReady && hasKey && isKeyTestedAndValid && !isAnalyzing;

  // Run the real analysis engine
  const handleAnalyzeClick = async (force = false) => {
    if (!isAnalyzeEnabled && !force) return;
    setIsAnalyzing(true);
    setScreen('analyzing');

    try {
      const result = await runAnalysisEngine(project, { forceReanalyze: force });
      if (result) {
        setBundle(result);
        setScreen('studio');
        showToast('Analysis complete');
      }
    } catch (err) {
      console.error('Analysis failed:', err);
      const isCancel =
        (err as Error)?.message === 'Analysis cancelled by user.' ||
        useAnalysisStore.getState().cancelRequested;
      if (!isCancel) {
        showToast((err as Error).message, 'error');
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleReanalyze = async () => {
    if (!project) return;
    try {
      await deleteAnalysisBundle(project.id);
      setBundle(null);
      await handleAnalyzeClick(true);
    } catch (err) {
      showToast(`Re-analysis failed: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ink)] text-[var(--text)]">
      {/* Header */}
      <header className="border-b border-[var(--ink-3)] safe-padding-top px-4 sm:px-8 py-3.5 bg-[var(--ink)] sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setScreen('home')}
              aria-label="Back to projects"
              className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-base font-bold tracking-tight text-[var(--text)] truncate max-w-[200px] sm:max-w-md">
                {project.name}
              </h1>
              <p className="text-xs text-[var(--text-2)] font-mono">Studio</p>
            </div>
          </div>

          <button
            type="button"
            onClick={openSettings}
            aria-label="Settings"
            className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Studio Workspace */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 safe-padding-bottom">
        <div className="flex flex-col lg:grid lg:grid-cols-12 gap-6 items-start">
          {/* Left / Top: Native Video Player & Analysis View */}
          <div className="w-full lg:col-span-7 flex flex-col gap-5">
            {/* Native Video Player */}
            <div className="w-full aspect-video rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] overflow-hidden flex items-center justify-center relative">
              {isLoadingBlob ? (
                <div className="flex flex-col items-center gap-2 text-xs text-[var(--text-2)]">
                  <Loader2 className="w-6 h-6 animate-spin text-[var(--volt)]" />
                  <span>Loading video from storage...</span>
                </div>
              ) : project.status === 'failed' ? (
                <div className="flex flex-col items-center p-6 text-center max-w-sm">
                  <AlertCircle className="w-8 h-8 text-[var(--danger)] mb-2" />
                  <p className="text-sm font-semibold text-[var(--text)] mb-1">
                    Failed to process video
                  </p>
                  <p className="text-xs text-[var(--text-2)] mb-4 leading-relaxed">
                    {project.error || 'An error occurred while reading video file.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => retryProject(project.id)}
                    className="px-4 py-2 rounded-[8px] bg-[var(--ink-3)] text-xs font-semibold hover:bg-[var(--ink-3)]/80 text-[var(--text)] inline-flex items-center gap-2 min-h-[44px]"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                  </button>
                </div>
              ) : project.status === 'saving' || project.status === 'probing' ? (
                <div className="flex flex-col items-center gap-3 text-xs text-[var(--text-2)]">
                  <Loader2 className="w-8 h-8 animate-spin text-[var(--volt)]" />
                  <span className="font-medium text-[var(--text)]">
                    {project.status === 'saving' ? 'Saving video...' : 'Reading video info...'}
                  </span>
                </div>
              ) : videoObjectUrl ? (
                <video
                  ref={videoRef}
                  src={videoObjectUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain bg-black"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-xs text-[var(--text-2)]">
                  <Film className="w-8 h-8 text-[var(--text-2)]/40" />
                  <span>No video stream available</span>
                </div>
              )}
            </div>

            {/* Analysis View (Loudness Waveform, Cuts, Transients, Playhead) */}
            {bundle && (
              <AnalysisView
                bundle={bundle}
                videoRef={videoRef}
                onSeek={(time) => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = time;
                  }
                }}
              />
            )}

            {/* Compact Analysis Report Card */}
            {bundle && (
              <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-[var(--volt)]" />
                    <h2 className="text-sm font-bold text-[var(--text)] tracking-tight">
                      Analysis Report
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={handleReanalyze}
                    className="px-3 py-1.5 rounded-[8px] border border-[var(--ink-3)] text-xs font-medium text-[var(--text)] hover:border-[var(--volt)] hover:text-[var(--volt)] transition-colors inline-flex items-center gap-1.5 min-h-[36px]"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Re-analyze
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Duration</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.duration.toFixed(1)}s
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Frame rate</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.fps ? `${bundle.fps} fps` : 'Variable'}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Audio</span>
                    <span className="font-mono font-medium text-[var(--text)] flex items-center gap-1">
                      {bundle.hasAudio ? (
                        <>
                          <Volume2 className="w-3.5 h-3.5 text-[var(--volt)]" />
                          <span>16 kHz mono</span>
                        </>
                      ) : (
                        <>
                          <VolumeX className="w-3.5 h-3.5 text-[var(--text-2)]" />
                          <span>No audio track</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Scene cuts</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.cuts.length} cuts
                    </span>
                  </div>

                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Transients</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.transients.length} sound hits
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Quiet gaps</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.quietGaps.length} pauses
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Frames sampled</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.samples.length} at 1 fps
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">AI Payload</span>
                    <span className="font-mono font-medium text-[var(--text)] tabular-nums">
                      {bundle.stats.payloadMB} MB
                    </span>
                  </div>
                </div>

                <div className="pt-2 border-t border-[var(--ink-3)] flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Mode: {bundle.stats.mode}</span>
                  </span>
                  <span>Time taken: {(bundle.stats.tookMs / 1000).toFixed(1)}s</span>
                </div>
              </div>
            )}

            {/* Video Metadata summary under player */}
            <div className="rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] p-4 sm:p-5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-2)] mb-3">
                Video Details
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Duration</span>
                  <span className="text-sm font-mono font-medium text-[var(--text)] tabular-nums">
                    {project.duration > 0 ? formatDuration(project.duration) : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Resolution</span>
                  <span className="text-sm font-mono font-medium text-[var(--text)] tabular-nums">
                    {project.width > 0 && project.height > 0
                      ? `${project.width} × ${project.height}`
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] text-[var(--text-2)] block mb-0.5">File size</span>
                  <span className="text-sm font-mono font-medium text-[var(--text)] tabular-nums">
                    {formatBytes(project.size)}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Status</span>
                  <span
                    className={`text-sm font-medium capitalize ${
                      project.status === 'ready'
                        ? 'text-[var(--volt)]'
                        : project.status === 'failed'
                        ? 'text-[var(--danger)]'
                        : 'text-[var(--text)]'
                    }`}
                  >
                    {project.status}
                  </span>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-[var(--ink-3)] flex items-center justify-between text-xs text-[var(--text-2)]">
                <span className="truncate max-w-[280px] sm:max-w-md font-mono">{project.name}</span>
              </div>
            </div>
          </div>

          {/* Right / Bottom Column: Action Panel */}
          <div className="w-full lg:col-span-5 flex flex-col gap-4">
            <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] p-5 sm:p-6 space-y-5">
              <div>
                <h2 className="text-base font-bold text-[var(--text)] tracking-tight">
                  Audio Analysis &amp; SFX
                </h2>
                <p className="text-xs text-[var(--text-2)] mt-1 leading-relaxed">
                  Real client-side audio decoding, frame diff scene cut detection, and transient extraction.
                </p>
              </div>

              {/* The Volt Analyze Button or Status */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => handleAnalyzeClick(false)}
                  disabled={!isAnalyzeEnabled}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-[12px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold text-sm tracking-wide uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-95 min-h-[48px]"
                >
                  <Sparkles className="w-4 h-4" />
                  {bundle ? 'Re-run Analysis' : 'Analyze'}
                </button>

                {/* One-line reason under Analyze button when disabled */}
                {disabledReason && (
                  <p className="text-xs text-[var(--text-2)] text-center leading-normal">
                    {disabledReason}
                    {(!hasKey || !isKeyTestedAndValid) && (
                      <button
                        type="button"
                        onClick={openSettings}
                        className="ml-1 text-[var(--volt)] underline font-medium hover:opacity-90 inline-block"
                      >
                        Open Settings
                      </button>
                    )}
                  </p>
                )}
              </div>

              {/* Prerequisites and Bundle status checklist */}
              <div className="pt-2 border-t border-[var(--ink-3)] space-y-2.5 text-xs">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">
                  Pipeline Status
                </span>
                <div className="flex items-center justify-between text-[var(--text-2)]">
                  <span>Video loaded &amp; probed</span>
                  <span className={`font-mono text-xs ${isVideoReady ? 'text-[var(--volt)]' : 'text-[var(--text-2)]'}`}>
                    {isVideoReady ? 'Ready' : project.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--text-2)]">
                  <span>Gemini API Key saved</span>
                  <span className={`font-mono text-xs ${hasKey ? 'text-[var(--volt)]' : 'text-[var(--text-2)]'}`}>
                    {hasKey ? 'Present' : 'Missing'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--text-2)]">
                  <span>API Key verified</span>
                  <span className={`font-mono text-xs ${isKeyTestedAndValid ? 'text-[var(--volt)]' : 'text-[var(--text-2)]'}`}>
                    {isKeyTestedAndValid ? 'Verified' : 'Unverified'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--text-2)]">
                  <span>Analysis cache</span>
                  <span className={`font-mono text-xs ${bundle ? 'text-[var(--volt)]' : 'text-[var(--text-2)]'}`}>
                    {bundle ? 'Cached in IndexedDB' : 'Not computed yet'}
                  </span>
                </div>
              </div>

              {/* Features computed in Step 2 */}
              <div className="pt-3 border-t border-[var(--ink-3)] space-y-2 text-xs text-[var(--text-2)]">
                <div className="flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-[var(--volt)]" />
                  <span>Real scene cuts &amp; 1 fps video reference</span>
                </div>
                <div className="flex items-center gap-2">
                  <Volume2 className="w-3.5 h-3.5 text-[var(--volt)]" />
                  <span>16 kHz PCM WAV + 50 Hz RMS dynamics</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
