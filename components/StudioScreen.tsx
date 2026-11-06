'use client';

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { getVideoBlob, getAnalysisBundle, deleteAnalysisBundle } from '@/lib/storage';
import { formatDuration, formatBytes } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { AnalysisBundle } from '@/types/analysis';
import { AnalysisView } from '@/components/AnalysisView';
import { runAnalysisEngine } from '@/analysis/engine';
import { useAnalysisStore } from '@/stores/use-analysis-store';
import { SfxPlan, SfxEvent, SFX_TYPES, getSfxPlan, deleteSfxPlan } from '@/ai/sfx-types';
import { applyDensity, DensityLevel } from '@/ai/density';
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
  SlidersHorizontal,
  Bot,
  Info,
  Clock,
  Target,
  Wand2,
} from 'lucide-react';

function formatEventTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

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
  const [plan, setPlan] = useState<SfxPlan | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [densityChoice, setDensityChoice] = useState<'auto' | DensityLevel>('auto');
  const [showSuggestionsAnyway, setShowSuggestionsAnyway] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeUrlRef = useRef<string | null>(null);

  const project = projects.find((p) => p.id === activeProjectId);
  const isLoadingBlob = Boolean(activeProjectId && loadedProjectId !== activeProjectId);

  // Load saved analysis bundle and SFX plan from IndexedDB
  useEffect(() => {
    let isCancelled = false;

    if (!activeProjectId) {
      return;
    }

    // Load bundle
    getAnalysisBundle(activeProjectId)
      .then((stored) => {
        if (!isCancelled) {
          setBundle(stored);
        }
      })
      .catch((err) => {
        console.error('Failed to load analysis bundle:', err);
      });

    // Load SFX plan
    getSfxPlan(activeProjectId)
      .then((storedPlan) => {
        if (!isCancelled) {
          setPlan(storedPlan);
        }
      })
      .catch((err) => {
        console.error('Failed to load SFX plan:', err);
      });

    // Load saved density setting for this project asynchronously
    Promise.resolve().then(() => {
      if (isCancelled) return;
      try {
        const savedDensity = localStorage.getItem(`sfx_density_${activeProjectId}`);
        if (
          savedDensity === 'auto' ||
          savedDensity === 'minimal' ||
          savedDensity === 'balanced' ||
          savedDensity === 'heavy'
        ) {
          setDensityChoice(savedDensity as 'auto' | DensityLevel);
        } else {
          setDensityChoice('auto');
        }
      } catch {
        setDensityChoice('auto');
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [activeProjectId]);

  // Load video blob from IndexedDB & create temporary runtime Object URL
  useEffect(() => {
    let isCancelled = false;

    if (!activeProjectId) {
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
      Promise.resolve().then(() => {
        if (!isCancelled) {
          setVideoObjectUrl(null);
          setLoadedProjectId(null);
        }
      });
      return;
    }

    getVideoBlob(activeProjectId)
      .then((blob) => {
        if (isCancelled) return;
        if (activeUrlRef.current) {
          URL.revokeObjectURL(activeUrlRef.current);
          activeUrlRef.current = null;
        }

        if (blob) {
          const url = URL.createObjectURL(blob);
          activeUrlRef.current = url;
          setVideoObjectUrl(url);
        } else {
          setVideoObjectUrl(null);
        }
        setLoadedProjectId(activeProjectId);
      })
      .catch((err) => {
        console.error('Failed to load video blob:', err);
        if (!isCancelled) {
          setVideoObjectUrl(null);
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

  // Density filter calculation (Pure local computation, NO API call)
  const filteredEvents: SfxEvent[] = useMemo(() => {
    if (!plan || !bundle) return [];
    if (!plan.needsSfx && densityChoice === 'auto' && !showSuggestionsAnyway) {
      return [];
    }

    const effectiveLevel: DensityLevel =
      densityChoice === 'auto'
        ? plan.recommendedDensity
        : densityChoice;

    return applyDensity(plan.candidates, bundle.duration, effectiveLevel);
  }, [plan, bundle, densityChoice, showSuggestionsAnyway]);

  const handleDensityChange = (choice: 'auto' | DensityLevel) => {
    setDensityChoice(choice);
    if (activeProjectId) {
      try {
        localStorage.setItem(`sfx_density_${activeProjectId}`, choice);
      } catch {
        // ignore
      }
    }
  };

  const handleSeekToEvent = (event: SfxEvent) => {
    setSelectedEventId(event.id);
    if (videoRef.current) {
      // Seek to 0.5s before the event hit
      const targetTime = Math.max(0, event.time - 0.5);
      videoRef.current.currentTime = targetTime;
      videoRef.current.play().catch(() => {});
    }
  };

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

  // Run the full analysis pipeline
  const handleAnalyzeClick = async (force = false) => {
    if (!project) return;
    setIsAnalyzing(true);
    setScreen('analyzing');

    try {
      const result = await runAnalysisEngine(project, { forceReanalyze: force });
      if (result) {
        setBundle(result.bundle);
        setPlan(result.plan);
        setScreen('studio');
        showToast('AI sound design complete');
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

  // Re-run AI Director only (reuses existing analysis bundle)
  const handleRerunAi = async () => {
    if (!project || !bundle) return;
    setIsAnalyzing(true);
    setScreen('analyzing');

    try {
      await deleteSfxPlan(project.id);
      setPlan(null);
      const result = await runAnalysisEngine(project, { forceAiOnly: true });
      if (result) {
        setBundle(result.bundle);
        setPlan(result.plan);
        setScreen('studio');
        showToast('AI director re-run complete');
      }
    } catch (err) {
      console.error('AI Re-run failed:', err);
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

  const handleReanalyzeAll = async () => {
    if (!project) return;
    try {
      await deleteAnalysisBundle(project.id);
      await deleteSfxPlan(project.id);
      setBundle(null);
      setPlan(null);
      await handleAnalyzeClick(true);
    } catch (err) {
      showToast(`Re-analysis failed: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ink)] text-[var(--text)]">
      {/* Top Header */}
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
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight text-[var(--text)] truncate max-w-[200px] sm:max-w-md">
                {project.name}
              </h1>
              <p className="text-xs text-[var(--text-2)] font-mono">
                {project.duration > 0 ? formatDuration(project.duration) : 'Probing...'}
                {project.width > 0 && ` · ${project.width}×${project.height}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openSettings}
              aria-label="Open settings"
              className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Studio Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 lg:p-8 safe-padding-bottom space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left / Top Column: Video Player & Timeline */}
          <div className="w-full lg:col-span-7 flex flex-col gap-4">
            {/* Player Container */}
            <div className="relative w-full aspect-video rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] overflow-hidden flex items-center justify-center shadow-none">
              {isLoadingBlob ? (
                <div className="flex flex-col items-center gap-2 text-xs text-[var(--text-2)]">
                  <Loader2 className="w-6 h-6 animate-spin text-[var(--volt)]" />
                  <span>Loading video from browser storage...</span>
                </div>
              ) : project.status === 'saving' || project.status === 'probing' ? (
                <div className="flex flex-col items-center gap-2 text-xs text-[var(--text-2)]">
                  <Loader2 className="w-6 h-6 animate-spin text-[var(--volt)]" />
                  <span>
                    {project.status === 'saving' ? 'Saving video file...' : 'Reading video properties...'}
                  </span>
                </div>
              ) : project.status === 'failed' ? (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-[var(--danger)]">
                  <AlertCircle className="w-8 h-8" />
                  <span className="font-semibold text-sm">Video Processing Failed</span>
                  <span className="text-[var(--text-2)] max-w-sm">{project.error}</span>
                  <button
                    type="button"
                    onClick={() => retryProject(project.id)}
                    className="mt-2 px-4 py-2 rounded-[8px] bg-[var(--ink-3)] text-[var(--text)] text-xs font-medium hover:bg-[var(--ink-3)]/80 inline-flex items-center gap-1.5 min-h-[44px]"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Retry Video Read</span>
                  </button>
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

            {/* Analysis View (Waveform, Cuts, Transients, SFX Diamonds, Playhead) */}
            {bundle && (
              <AnalysisView
                bundle={bundle}
                events={filteredEvents}
                videoRef={videoRef}
                onSeek={(time) => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = time;
                  }
                }}
                onSelectEvent={(ev) => setSelectedEventId(ev.id)}
              />
            )}

            {/* AI Report Card (Step 3) */}
            {plan && (
              <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4 text-[var(--volt)]" />
                    <h2 className="text-sm font-bold text-[var(--text)] tracking-tight">
                      AI Director Report
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={handleRerunAi}
                    className="px-3 py-1.5 rounded-[8px] border border-[var(--ink-3)] text-xs font-medium text-[var(--text)] hover:border-[var(--volt)] hover:text-[var(--volt)] transition-colors inline-flex items-center gap-1.5 min-h-[36px]"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Re-run AI</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Video Type</span>
                    <span className="font-medium text-[var(--text)] capitalize truncate block">
                      {plan.videoType}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Mood</span>
                    <span className="font-medium text-[var(--text)] capitalize truncate block">
                      {plan.mood}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Needs SFX</span>
                    <span className={`font-medium ${plan.needsSfx ? 'text-[var(--volt)]' : 'text-[var(--text-2)]'}`}>
                      {plan.needsSfx ? 'Yes' : 'No / Minimal'}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    <span className="text-[11px] text-[var(--text-2)] block mb-0.5">Candidates</span>
                    <span className="font-mono font-medium text-[var(--text)]">
                      {plan.candidates.length} sounds
                    </span>
                  </div>
                </div>

                {plan.summary && (
                  <p className="text-xs text-[var(--text-2)] leading-relaxed italic">
                    &ldquo;{plan.summary}&rdquo;
                  </p>
                )}

                <div className="pt-2 border-t border-[var(--ink-3)] flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-[var(--volt)]" />
                    <span>Model: {plan.model.replace(/^models\//, '')}</span>
                  </span>
                  <span>Recommended: {plan.recommendedDensity}</span>
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
            </div>
          </div>

          {/* Right Column: Sound Design Panel */}
          <div className="w-full lg:col-span-5 flex flex-col gap-4">
            <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] p-5 sm:p-6 space-y-5">
              <div>
                <h2 className="text-base font-bold text-[var(--text)] tracking-tight">
                  AI Sound Design
                </h2>
                <p className="text-xs text-[var(--text-2)] mt-1 leading-relaxed">
                  Multimodal Gemini AI Director detects key beats and snaps sound effects to scene cuts and audio dynamics.
                </p>
              </div>

              {/* The Volt Analyze Button */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => handleAnalyzeClick(false)}
                  disabled={!isAnalyzeEnabled}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-[12px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold text-sm tracking-wide uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-95 min-h-[48px]"
                >
                  <Sparkles className="w-4 h-4" />
                  {plan ? 'Re-run Pipeline' : 'Analyze & Design SFX'}
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

              {/* Density Controls (Step 3) */}
              {plan && (
                <div className="pt-3 border-t border-[var(--ink-3)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-2)] flex items-center gap-1.5">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--volt)]" />
                      <span>Density Filter</span>
                    </span>
                    <span className="text-xs font-mono text-[var(--volt)]">
                      {filteredEvents.length} of {plan.candidates.length} sounds
                    </span>
                  </div>

                  {/* Density button row: Auto, Minimal, Balanced, Heavy */}
                  <div className="grid grid-cols-4 gap-1.5 p-1 rounded-[10px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    {(['auto', 'minimal', 'balanced', 'heavy'] as const).map((lvl) => {
                      const isActive = densityChoice === lvl;
                      return (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => handleDensityChange(lvl)}
                          className={`py-2 px-1 text-xs font-medium rounded-[8px] transition-all capitalize min-h-[40px] ${
                            isActive
                              ? 'bg-[var(--volt)] text-[var(--volt-ink)] font-semibold'
                              : 'text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)]'
                          }`}
                        >
                          {lvl === 'auto' ? `Auto (${plan.recommendedDensity[0].toUpperCase()})` : lvl}
                        </button>
                      );
                    })}
                  </div>

                  {/* Banner when needsSfx is false */}
                  {!plan.needsSfx && densityChoice === 'auto' && !showSuggestionsAnyway && (
                    <div className="p-3 rounded-[10px] bg-[var(--ink)] border border-[var(--ink-3)] space-y-2">
                      <div className="flex items-start gap-2 text-xs text-[var(--text-2)]">
                        <Info className="w-4 h-4 text-[var(--volt)] shrink-0 mt-0.5" />
                        <span>The AI thinks this video doesn&apos;t need sound effects.</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowSuggestionsAnyway(true)}
                        className="w-full py-1.5 px-3 rounded-[6px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-xs font-medium text-[var(--text)] hover:border-[var(--volt)] transition-colors min-h-[36px]"
                      >
                        Show suggestions anyway
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Event List (Read-only for Step 3) */}
              {plan && (
                <div className="pt-3 border-t border-[var(--ink-3)] space-y-3">
                  <div className="flex items-center justify-between text-xs text-[var(--text-2)]">
                    <span className="font-semibold uppercase tracking-wider text-[11px]">
                      Selected Sound Effects
                    </span>
                    <span className="font-mono text-[11px]">
                      Tap sound to seek (-0.5s)
                    </span>
                  </div>

                  {filteredEvents.length === 0 ? (
                    <div className="p-6 text-center text-xs text-[var(--text-2)] bg-[var(--ink)] rounded-[12px] border border-[var(--ink-3)]">
                      No sound effects selected for this density.
                    </div>
                  ) : (
                    <div className="max-h-[380px] overflow-y-auto space-y-2 pr-1">
                      {filteredEvents.map((ev) => {
                        const isSelected = selectedEventId === ev.id;
                        const typeDesc = SFX_TYPES[ev.type] || ev.type;

                        return (
                          <div
                            key={ev.id}
                            onClick={() => handleSeekToEvent(ev)}
                            className={`p-3 rounded-[10px] border transition-all cursor-pointer text-xs ${
                              isSelected
                                ? 'bg-[var(--ink-3)] border-[var(--volt)] glow-volt-border'
                                : 'bg-[var(--ink)] border-[var(--ink-3)] hover:border-[var(--ink-3)]/80 hover:bg-[var(--ink)]/80'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[var(--volt)] font-bold text-sm">◆</span>
                                <span className="font-bold text-[var(--text)] truncate">
                                  {ev.type}
                                </span>
                                <span className="px-1.5 py-0.5 rounded-[4px] bg-[var(--ink-2)] text-[10px] font-mono text-[var(--text-2)] uppercase">
                                  {ev.intent}
                                </span>
                              </div>
                              <span className="font-mono font-medium text-[var(--volt)] tabular-nums shrink-0">
                                {formatEventTime(ev.time)}
                              </span>
                            </div>

                            <p className="text-[11px] text-[var(--text-2)] line-clamp-2 mb-2">
                              {ev.reason}
                            </p>

                            <div className="flex items-center justify-between text-[10px] text-[var(--text-2)] font-mono pt-1.5 border-t border-[var(--ink-3)]/40">
                              <span className="flex items-center gap-1">
                                <Target className="w-3 h-3 text-[var(--text-2)]" />
                                <span>
                                  Snapped:{' '}
                                  <strong
                                    className={
                                      ev.snapped === 'cut'
                                        ? 'text-white'
                                        : ev.snapped === 'transient'
                                        ? 'text-[var(--volt)]'
                                        : 'text-[var(--text-2)]'
                                    }
                                  >
                                    {ev.snapped}
                                  </strong>
                                </span>
                              </span>
                              <span>Conf: {Math.round(ev.confidence * 100)}%</span>
                              <span>Vol: {Math.round(ev.volume * 100)}%</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
