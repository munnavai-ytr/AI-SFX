'use client';

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/use-app-store';
import { getVideoBlob, getAnalysisBundle, deleteAnalysisBundle } from '@/lib/storage';
import { formatDuration, formatBytes } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { AnalysisBundle } from '@/types/analysis';
import { AnalysisView } from '@/components/AnalysisView';
import { runAnalysisEngine } from '@/analysis/engine';
import { useAnalysisStore } from '@/stores/use-analysis-store';
import {
  SfxPlan,
  SfxEvent,
  SfxType,
  SFX_TYPES,
  SFX_INTENTS,
  SfxEditEvent,
  SfxEditState,
  getSfxPlan,
  deleteSfxPlan,
  getSfxEditState,
  saveSfxEditState,
  deleteSfxEditState,
} from '@/ai/sfx-types';
import { applyDensity, DensityLevel } from '@/ai/density';
import { getSfxSound } from '@/audio/sfx/manager';
import { renderSfxBus, sfxPeakDb } from '@/audio/mix';
import {
  PreviewScheduler,
  playSingleSound,
  getStoredMasterVolume,
  setStoredMasterVolume,
  getStoredSyncOffsetMs,
  setStoredSyncOffsetMs,
  getStoredAudioMode,
  setStoredAudioMode,
  AudioMode,
  getSharedAudioContext,
} from '@/audio/preview';
import { SfxTestScreen } from '@/components/SfxTestScreen';
import { ExportModal } from '@/components/ExportModal';
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
  Plus,
  RotateCcw,
  Undo2,
  Redo2,
  Trash2,
  Play,
  Pause,
  Shuffle,
  Volume1,
  Music,
  Check,
  ChevronDown,
  Download,
  WifiOff,
} from 'lucide-react';

function formatEventTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

const MAX_HISTORY = 50;

export function StudioScreen() {
  const {
    activeProjectId,
    projects,
    setScreen,
    openSettings,
    apiKey,
    keyTestState,
    retryProject,
  } = useAppStore(
    useShallow((s) => ({
      activeProjectId: s.activeProjectId,
      projects: s.projects,
      setScreen: s.setScreen,
      openSettings: s.openSettings,
      apiKey: s.apiKey,
      keyTestState: s.keyTestState,
      retryProject: s.retryProject,
    }))
  );

  const { showToast } = useToast();
  const [videoObjectUrl, setVideoObjectUrl] = useState<string | null>(null);
  const [rawVideoBlob, setRawVideoBlob] = useState<Blob | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<AnalysisBundle | null>(null);
  const [plan, setPlan] = useState<SfxPlan | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [densityChoice, setDensityChoice] = useState<'auto' | DensityLevel>('auto');
  const [showSuggestionsAnyway, setShowSuggestionsAnyway] = useState(false);
  const [showSoundTest, setShowSoundTest] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // Audio & Scheduler State
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioMode, setAudioMode] = useState<AudioMode>(() => getStoredAudioMode());
  const [masterVol, setMasterVol] = useState<number>(() => getStoredMasterVolume());
  const [syncOffset, setSyncOffset] = useState<number>(() => getStoredSyncOffsetMs());
  const [preparingCount, setPreparingCount] = useState<{ done: number; total: number } | null>(null);

  // Working List & History State
  const [events, setEvents] = useState<SfxEditEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [history, setHistory] = useState<SfxEditEvent[][]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [hasManualEdits, setHasManualEdits] = useState<boolean>(false);
  const [showDensityConfirm, setShowDensityConfirm] = useState<DensityLevel | null>(null);

  // Measured Header Mix Stats
  const [measuredPeakDb, setMeasuredPeakDb] = useState<number | null>(null);

  // Add SFX picker state
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addType, setAddType] = useState<SfxType>('whoosh_fast');

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeUrlRef = useRef<string | null>(null);
  const schedulerRef = useRef<PreviewScheduler | null>(null);
  const initializedKeyRef = useRef<string>('');

  const project = projects.find((p) => p.id === activeProjectId);
  const isLoadingBlob = Boolean(activeProjectId && loadedProjectId !== activeProjectId);

  // Helper to push history state for Undo/Redo
  const pushState = useCallback(
    (newEvents: SfxEditEvent[], isManual = true) => {
      setEvents(newEvents);
      if (isManual) setHasManualEdits(true);

      setHistory((prev) => {
        const sliced = prev.slice(0, historyIdx + 1);
        const updated = [...sliced, newEvents];
        if (updated.length > MAX_HISTORY) updated.shift();
        return updated;
      });
      setHistoryIdx((prev) => Math.min(MAX_HISTORY - 1, prev + 1));
    },
    [historyIdx]
  );

  const handleUndo = () => {
    if (historyIdx > 0) {
      const prevIdx = historyIdx - 1;
      setHistoryIdx(prevIdx);
      setEvents(history[prevIdx]);
    }
  };

  const handleRedo = () => {
    if (historyIdx < history.length - 1) {
      const nextIdx = historyIdx + 1;
      setHistoryIdx(nextIdx);
      setEvents(history[nextIdx]);
    }
  };

  // Load saved analysis bundle, plan, and working edit list from IndexedDB
  useEffect(() => {
    let isCancelled = false;

    if (!activeProjectId) return;

    // Load bundle
    getAnalysisBundle(activeProjectId)
      .then((stored) => {
        if (!isCancelled) setBundle(stored);
      })
      .catch((err) => console.error('Failed to load analysis bundle:', err));

    // Load SFX plan
    getSfxPlan(activeProjectId)
      .then((storedPlan) => {
        if (!isCancelled) setPlan(storedPlan);
      })
      .catch((err) => console.error('Failed to load SFX plan:', err));

    // Load SFX edit state or initialize from plan
    if (initializedKeyRef.current !== activeProjectId) {
      getSfxEditState(activeProjectId)
        .then((storedState) => {
          if (isCancelled) return;
          if (storedState && Array.isArray(storedState.events)) {
            setEvents(storedState.events);
            setDensityChoice(storedState.density || 'auto');
            setHasManualEdits(Boolean(storedState.hasManualEdits));
            setHistory([storedState.events]);
            setHistoryIdx(0);
            initializedKeyRef.current = activeProjectId;
          } else {
            // Initialize working list from plan if available
            getSfxPlan(activeProjectId).then((planData) => {
              if (isCancelled || !planData) return;
              const level: DensityLevel = planData.recommendedDensity || 'balanced';
              const candidates = applyDensity(planData.candidates, planData.summary ? 30 : 60, level);
              const initial: SfxEditEvent[] = candidates.map((c) => ({
                ...c,
                variant: 0,
                enabled: true,
              }));
              setEvents(initial);
              setDensityChoice('auto');
              setHistory([initial]);
              setHistoryIdx(0);
              initializedKeyRef.current = activeProjectId;
            });
          }
        })
        .catch((err) => console.error('Failed to load SFX edit state:', err));
    }

    return () => {
      isCancelled = true;
    };
  }, [activeProjectId]);

  // Persist working list whenever events change
  useEffect(() => {
    if (!activeProjectId || events.length === 0) return;
    const editState: SfxEditState = {
      projectId: activeProjectId,
      events,
      density: densityChoice,
      masterVolume: masterVol,
      syncOffsetMs: syncOffset,
      updatedAt: Date.now(),
      hasManualEdits,
    };
    saveSfxEditState(editState);
  }, [activeProjectId, events, densityChoice, masterVol, syncOffset, hasManualEdits]);

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
        setRawVideoBlob(blob);
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
          setRawVideoBlob(null);
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

  // Compute real offline mix peak dBFS whenever events change
  useEffect(() => {
    let isCancelled = false;

    if (!bundle || events.length === 0) {
      Promise.resolve().then(() => {
        if (!isCancelled) setMeasuredPeakDb(null);
      });
      return;
    }

    const duration = bundle.duration || 1;
    const speech = plan ? plan.speech : [];
    const basePeak = sfxPeakDb(bundle.envelopeDb);

    renderSfxBus(
      events,
      (e) => getSfxSound(e.type, e.variant),
      duration,
      speech,
      basePeak,
      masterVol
    ).then(([leftBus]) => {
      if (isCancelled) return;
      let maxAmp = 0;
      for (let i = 0; i < leftBus.length; i++) {
        maxAmp = Math.max(maxAmp, Math.abs(leftBus[i]));
      }
      const peakDb = maxAmp > 0 ? Number((20 * Math.log10(maxAmp)).toFixed(1)) : -120;
      setMeasuredPeakDb((prev) => (prev === peakDb ? prev : peakDb));
    });

    return () => {
      isCancelled = true;
    };
  }, [events, bundle, plan, masterVol]);

  // Handle Video Play / Pause & Preview Scheduler Synchronization
  const togglePlayPause = async () => {
    if (!videoRef.current) return;

    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
      if (schedulerRef.current) {
        schedulerRef.current.stop();
      }
    } else {
      // Resume shared AudioContext
      getSharedAudioContext();

      if (!schedulerRef.current && videoRef.current) {
        schedulerRef.current = new PreviewScheduler(
          videoRef.current,
          () => events,
          plan ? plan.speech : [],
          bundle ? bundle.envelopeDb : null,
          (done, total) => {
            setPreparingCount((prev) => {
              if (prev && prev.done === done && prev.total === total) return prev;
              return done < total ? { done, total } : null;
            });
          }
        );
      }

      if (schedulerRef.current) {
        await schedulerRef.current.prepare(events);
        schedulerRef.current.start();
      }

      videoRef.current.play().catch((err) => console.error('Play failed:', err));
      setIsPlaying(true);
    }
  };

  // Video element event listeners
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onPause = () => {
      setIsPlaying(false);
      if (schedulerRef.current) schedulerRef.current.stop();
    };
    const onEnded = () => {
      setIsPlaying(false);
      if (schedulerRef.current) schedulerRef.current.stop();
    };

    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);

    return () => {
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
    };
  }, [videoObjectUrl]);

  // Density change handling with confirmation if manual edits exist
  const applyDensityChange = (level: DensityLevel) => {
    if (!plan || !bundle) return;
    const candidates = applyDensity(plan.candidates, bundle.duration, level);
    const newEvents: SfxEditEvent[] = candidates.map((c) => ({
      ...c,
      variant: 0,
      enabled: true,
    }));
    setDensityChoice(level);
    setHasManualEdits(false);
    pushState(newEvents, false);
    showToast(`Applied ${level} sound density (${newEvents.length} events)`);
  };

  const handleDensityClick = (level: DensityLevel) => {
    if (hasManualEdits) {
      setShowDensityConfirm(level);
    } else {
      applyDensityChange(level);
    }
  };

  const handleResetToAi = () => {
    if (!plan || !bundle) return;
    const level = densityChoice === 'auto' ? plan.recommendedDensity : densityChoice;
    applyDensityChange(level);
  };

  // Edit actions on selected event
  const selectedEvent = events.find((e) => e.id === selectedEventId) || null;

  const handleUpdateEvent = (id: string, patch: Partial<SfxEditEvent>) => {
    const updated = events.map((e) => (e.id === id ? { ...e, ...patch } : e));
    pushState(updated, true);
  };

  const handleDeleteEvent = (id: string) => {
    const updated = events.filter((e) => e.id !== id);
    if (selectedEventId === id) setSelectedEventId(null);
    pushState(updated, true);
    showToast('Sound effect deleted');
  };

  const handleCycleVariant = (id: string) => {
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    const nextV = ((ev.variant + 1) % 3) as 0 | 1 | 2;
    handleUpdateEvent(id, { variant: nextV });

    // Audition sound single
    getSfxSound(ev.type, nextV).then((s) => playSingleSound(s, ev.volume, masterVol));
  };

  const handlePlaySingleEventPreview = async (ev: SfxEditEvent) => {
    getSharedAudioContext();
    const s = await getSfxSound(ev.type, ev.variant);
    await playSingleSound(s, ev.volume, masterVol);
  };

  const handleAddSfxAtPlayhead = () => {
    const videoTime = videoRef.current ? videoRef.current.currentTime : 0;
    const clampedTime = Number(
      Math.min(
        Math.max(videoTime, 0.05),
        bundle ? Math.max(0.05, bundle.duration - 0.2) : 10
      ).toFixed(3)
    );

    let intent: SfxEditEvent['intent'] = 'emphasis';
    if (['whoosh_fast', 'whoosh_slow', 'swipe'].includes(addType)) intent = 'transition';
    else if (['pop', 'click', 'typing', 'notification'].includes(addType)) intent = 'text_on_screen';

    const newEv: SfxEditEvent = {
      id: `evt_user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      time: clampedTime,
      type: addType,
      variant: 0,
      volume: 0.8,
      intent,
      enabled: true,
      reason: 'User added sound effect',
      confidence: 1.0,
      snapped: 'none',
    };

    const updated = [...events, newEv].sort((a, b) => a.time - b.time);
    setSelectedEventId(newEv.id);
    setShowAddPicker(false);
    pushState(updated, true);
    showToast(`Added ${addType} at ${clampedTime.toFixed(2)}s`);
  };

  const handleAudioModeToggle = (mode: AudioMode) => {
    setAudioMode(mode);
    setStoredAudioMode(mode);
  };

  const handleMasterVolChange = (v: number) => {
    setMasterVol(v);
    setStoredMasterVolume(v);
  };

  const handleSyncOffsetChange = (offsetMs: number) => {
    setSyncOffset(offsetMs);
    setStoredSyncOffsetMs(offsetMs);
  };

  const handleTestSyncClick = async () => {
    getSharedAudioContext();
    const clickSound = await getSfxSound('click', 0);
    await playSingleSound(clickSound, 1.0, masterVol);
  };

  if (showSoundTest) {
    return <SfxTestScreen onBack={() => setShowSoundTest(false)} />;
  }

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
  if (!isOnline) {
    disabledReason = "You're offline. AI analysis needs internet; editing and export still work.";
  } else if (project.status === 'saving') {
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

  const isAnalyzeEnabled = isVideoReady && hasKey && isKeyTestedAndValid && !isAnalyzing && isOnline;

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

        // Initialize working list from plan
        const level: DensityLevel = result.plan.recommendedDensity || 'balanced';
        const candidates = applyDensity(result.plan.candidates, result.bundle.duration, level);
        const initial: SfxEditEvent[] = candidates.map((c) => ({
          ...c,
          variant: 0,
          enabled: true,
        }));
        setEvents(initial);
        setHistory([initial]);
        setHistoryIdx(0);
        setHasManualEdits(false);

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

  const enabledCount = events.filter((e) => e.enabled).length;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ink)] text-[var(--text)]">
      {/* Top Header */}
      <header className="border-b border-[var(--ink-3)] safe-padding-top px-4 sm:px-8 py-3.5 bg-[var(--ink)] sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setScreen('home')}
              aria-label="Back to projects"
              className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight text-[var(--text)] truncate max-w-[180px] sm:max-w-xs md:max-w-sm">
                {project.name}
              </h1>
              <p className="text-xs text-[var(--text-2)] font-mono">
                {project.duration > 0 ? formatDuration(project.duration) : 'Probing...'}
                {measuredPeakDb !== null && (
                  <span className="ml-2 text-[var(--volt)]">
                    · {enabledCount} sound effects · peak {measuredPeakDb} dBFS
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleUndo}
              disabled={historyIdx <= 0}
              aria-label="Undo edit"
              title="Undo"
              className="w-10 h-10 flex items-center justify-center rounded-[8px] border border-[var(--ink-3)] text-[var(--text-2)] hover:text-[var(--text)] hover:border-[var(--volt)]/50 disabled:opacity-40 min-h-[40px]"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={historyIdx >= history.length - 1}
              aria-label="Redo edit"
              title="Redo"
              className="w-10 h-10 flex items-center justify-center rounded-[8px] border border-[var(--ink-3)] text-[var(--text-2)] hover:text-[var(--text)] hover:border-[var(--volt)]/50 disabled:opacity-40 min-h-[40px]"
            >
              <Redo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowExportModal(true)}
              disabled={!bundle || events.length === 0}
              aria-label="Export video"
              title="Export video with SFX"
              className="px-3.5 py-2 rounded-[10px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold text-xs hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 min-h-[44px] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              <span>Export</span>
            </button>
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
        {/* Offline Banner */}
        {!isOnline && (
          <div className="p-3.5 rounded-[12px] bg-[var(--ink-2)] border border-[var(--danger)]/50 text-xs text-[var(--danger)] flex items-center gap-2.5 font-mono">
            <WifiOff className="w-4 h-4 shrink-0" />
            <span>You&apos;re offline. AI analysis needs internet; editing and export still work.</span>
          </div>
        )}

        {/* Preparing Sounds Overlay / Toast Banner */}
        {preparingCount && (
          <div className="p-3 rounded-[10px] bg-[var(--ink-2)] border border-[var(--volt)] text-xs text-[var(--volt)] flex items-center justify-between glow-volt-border animate-pulse">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Preparing sounds {preparingCount.done}/{preparingCount.total}...</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Video Player & Timeline */}
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

            {/* Transport & Audio Mode Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-xs">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={togglePlayPause}
                  disabled={!videoObjectUrl}
                  className="px-4 py-2 rounded-[8px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 min-h-[40px]"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                  <span>{isPlaying ? 'Pause' : 'Play'}</span>
                </button>
              </div>

              {/* Mode Comparison Switch: Original | With SFX */}
              <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)]">
                <button
                  type="button"
                  onClick={() => handleAudioModeToggle('with_sfx')}
                  className={`px-3 py-1.5 rounded-[6px] text-xs font-semibold transition-all min-h-[36px] ${
                    audioMode === 'with_sfx'
                      ? 'bg-[var(--volt)] text-[var(--volt-ink)]'
                      : 'text-[var(--text-2)] hover:text-[var(--text)]'
                  }`}
                >
                  With SFX
                </button>
                <button
                  type="button"
                  onClick={() => handleAudioModeToggle('original')}
                  className={`px-3 py-1.5 rounded-[6px] text-xs font-semibold transition-all min-h-[36px] ${
                    audioMode === 'original'
                      ? 'bg-[var(--ink-3)] text-white'
                      : 'text-[var(--text-2)] hover:text-[var(--text)]'
                  }`}
                >
                  Original Only
                </button>
              </div>
            </div>

            {/* Analysis & SFX Timeline View (Drag & Snap enabled) */}
            {bundle && (
              <AnalysisView
                bundle={bundle}
                events={events}
                selectedEventId={selectedEventId}
                videoRef={videoRef}
                onSeek={(time) => {
                  if (videoRef.current) videoRef.current.currentTime = time;
                }}
                onSelectEvent={(ev) => setSelectedEventId(ev.id)}
                onEventTimeChange={(id, newTime) => handleUpdateEvent(id, { time: newTime })}
              />
            )}

            {/* Selected Event Card (Step 4 Editor) */}
            {selectedEvent ? (
              <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--volt)]/60 p-5 space-y-4 glow-volt-border animate-in fade-in-0 duration-150">
                <div className="flex items-center justify-between border-b border-[var(--ink-3)] pb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--volt)] font-bold text-base">◆</span>
                    <h3 className="text-sm font-bold text-[var(--text)] font-mono">
                      Edit Event
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handlePlaySingleEventPreview(selectedEvent)}
                      className="px-3 py-1.5 rounded-[8px] bg-[var(--volt)] text-[var(--volt-ink)] text-xs font-semibold hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 min-h-[36px]"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Preview sound</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteEvent(selectedEvent.id)}
                      className="p-2 rounded-[8px] border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  {/* Type Dropdown */}
                  <div className="space-y-1">
                    <label className="text-[11px] text-[var(--text-2)] font-mono block">
                      Sound Type
                    </label>
                    <select
                      value={selectedEvent.type}
                      onChange={(e) => handleUpdateEvent(selectedEvent.id, { type: e.target.value as SfxType })}
                      className="w-full bg-[var(--ink)] border border-[var(--ink-3)] rounded-[8px] px-3 py-2 text-xs font-mono text-[var(--text)] focus:border-[var(--volt)] focus:outline-none min-h-[40px]"
                    >
                      {Object.keys(SFX_TYPES).map((t) => (
                        <option key={t} value={t}>
                          {t} — {SFX_TYPES[t as SfxType]}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Variant Swap Button */}
                  <div className="space-y-1">
                    <label className="text-[11px] text-[var(--text-2)] font-mono block">
                      Sound Variant
                    </label>
                    <button
                      type="button"
                      onClick={() => handleCycleVariant(selectedEvent.id)}
                      className="w-full px-3 py-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] hover:border-[var(--volt)] text-xs font-mono text-[var(--text)] flex items-center justify-between transition-colors min-h-[40px]"
                    >
                      <span>Variant {selectedEvent.variant + 1} of 3</span>
                      <Shuffle className="w-3.5 h-3.5 text-[var(--volt)]" />
                    </button>
                  </div>

                  {/* Time Nudge Controls */}
                  <div className="space-y-1">
                    <label className="text-[11px] text-[var(--text-2)] font-mono block">
                      Time (mm:ss.ms)
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateEvent(selectedEvent.id, {
                            time: Number(Math.max(0.05, selectedEvent.time - 0.05).toFixed(3)),
                          })
                        }
                        className="px-2.5 py-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs font-semibold text-[var(--text)] hover:border-[var(--volt)] min-h-[40px]"
                      >
                        -0.05s
                      </button>
                      <span className="flex-1 text-center font-mono font-bold text-xs bg-[var(--ink)] border border-[var(--ink-3)] rounded-[8px] py-2">
                        {formatEventTime(selectedEvent.time)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateEvent(selectedEvent.id, {
                            time: Number(
                              Math.min(
                                bundle ? bundle.duration - 0.2 : 100,
                                selectedEvent.time + 0.05
                              ).toFixed(3)
                            ),
                          })
                        }
                        className="px-2.5 py-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs font-semibold text-[var(--text)] hover:border-[var(--volt)] min-h-[40px]"
                      >
                        +0.05s
                      </button>
                    </div>
                  </div>

                  {/* Volume Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-[var(--text-2)] font-mono">
                      <span>Volume</span>
                      <span>{Math.round(selectedEvent.volume * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={selectedEvent.volume}
                      onChange={(e) =>
                        handleUpdateEvent(selectedEvent.id, { volume: parseFloat(e.target.value) })
                      }
                      className="w-full accent-[var(--volt)] h-2 rounded-lg cursor-pointer bg-[var(--ink-3)]"
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Right Column: Sound Controls & Editable Sound List */}
          <div className="w-full lg:col-span-5 flex flex-col gap-4">
            <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] p-5 sm:p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-[var(--text)] tracking-tight">
                    Sound Effects Mixer
                  </h2>
                  <p className="text-xs text-[var(--text-2)] mt-0.5">
                    Customize timeline placement, density, and sound variants.
                  </p>
                </div>
                {plan && (
                  <button
                    type="button"
                    onClick={() => setShowAddPicker(!showAddPicker)}
                    className="px-3 py-2 rounded-[8px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold text-xs hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 min-h-[40px]"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add SFX</span>
                  </button>
                )}
              </div>

              {/* Add SFX Form Dropdown */}
              {showAddPicker && (
                <div className="p-4 rounded-[12px] bg-[var(--ink)] border border-[var(--volt)]/50 space-y-3 animate-in fade-in-0 duration-150">
                  <span className="text-xs font-bold text-[var(--text)] block">
                    Add Sound Effect at Current Playhead Position
                  </span>
                  <select
                    value={addType}
                    onChange={(e) => setAddType(e.target.value as SfxType)}
                    className="w-full bg-[var(--ink-2)] border border-[var(--ink-3)] rounded-[8px] px-3 py-2 text-xs font-mono text-[var(--text)] focus:border-[var(--volt)] focus:outline-none min-h-[40px]"
                  >
                    {Object.keys(SFX_TYPES).map((t) => (
                      <option key={t} value={t}>
                        {t} — {SFX_TYPES[t as SfxType]}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddPicker(false)}
                      className="px-3 py-1.5 rounded-[6px] border border-[var(--ink-3)] text-xs text-[var(--text-2)] min-h-[36px]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleAddSfxAtPlayhead}
                      className="px-4 py-1.5 rounded-[6px] bg-[var(--volt)] text-[var(--volt-ink)] text-xs font-bold min-h-[36px]"
                    >
                      Insert
                    </button>
                  </div>
                </div>
              )}

              {/* Analyze / Re-run Pipeline Button */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => handleAnalyzeClick(false)}
                  disabled={!isAnalyzeEnabled}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-[12px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold text-sm tracking-wide uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-95 min-h-[48px]"
                >
                  <Sparkles className="w-4 h-4" />
                  {plan ? 'Re-run AI Analysis' : 'Analyze & Design SFX'}
                </button>

                {disabledReason && (
                  <p className="text-xs text-[var(--text-2)] text-center leading-normal">
                    {disabledReason}
                  </p>
                )}
              </div>

              {/* Density Controls & Reset */}
              {plan && (
                <div className="pt-3 border-t border-[var(--ink-3)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-2)] flex items-center gap-1.5">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--volt)]" />
                      <span>Density Suggestion</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleResetToAi}
                      className="text-xs text-[var(--volt)] hover:underline inline-flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Reset to AI</span>
                    </button>
                  </div>

                  {/* Confirm Replace Dialog */}
                  {showDensityConfirm && (
                    <div className="p-3 rounded-[10px] bg-[var(--ink)] border border-[var(--danger)]/40 space-y-2 text-xs">
                      <p className="text-[var(--text)] font-medium">
                        Replace your custom edits with the {showDensityConfirm} suggestion?
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const target = showDensityConfirm;
                            setShowDensityConfirm(null);
                            applyDensityChange(target);
                          }}
                          className="px-3 py-1.5 rounded-[6px] bg-[var(--danger)] text-white font-semibold text-xs min-h-[36px]"
                        >
                          Replace edits
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowDensityConfirm(null)}
                          className="px-3 py-1.5 rounded-[6px] bg-[var(--ink-3)] text-[var(--text)] text-xs min-h-[36px]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Density selector buttons */}
                  <div className="grid grid-cols-4 gap-1.5 p-1 rounded-[10px] bg-[var(--ink)] border border-[var(--ink-3)]">
                    {(['auto', 'minimal', 'balanced', 'heavy'] as const).map((lvl) => {
                      const isActive = densityChoice === lvl;
                      return (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => handleDensityClick(lvl === 'auto' ? plan.recommendedDensity : lvl)}
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
                </div>
              )}

              {/* Master Volume & Sync Offset Settings */}
              <div className="pt-3 border-t border-[var(--ink-3)] space-y-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)] block">
                  Audio &amp; Sync Settings
                </span>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-[var(--text-2)] font-mono">
                    <span>SFX Master Volume</span>
                    <span>{Math.round(masterVol * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.05"
                    value={masterVol}
                    onChange={(e) => handleMasterVolChange(parseFloat(e.target.value))}
                    className="w-full accent-[var(--volt)] h-2 rounded-lg cursor-pointer bg-[var(--ink-3)]"
                  />
                </div>

                <div className="space-y-1 pt-1">
                  <div className="flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
                    <span>Sync Offset</span>
                    <div className="flex items-center gap-2">
                      <span>{syncOffset > 0 ? `+${syncOffset}` : syncOffset} ms</span>
                      <button
                        type="button"
                        onClick={handleTestSyncClick}
                        className="px-2 py-0.5 rounded-[4px] bg-[var(--ink)] border border-[var(--ink-3)] text-[10px] font-mono text-[var(--volt)] hover:border-[var(--volt)] transition-colors min-h-[28px]"
                      >
                        Test
                      </button>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="-300"
                    max="300"
                    step="10"
                    value={syncOffset}
                    onChange={(e) => handleSyncOffsetChange(parseInt(e.target.value, 10))}
                    className="w-full accent-[var(--volt)] h-2 rounded-lg cursor-pointer bg-[var(--ink-3)]"
                  />
                </div>

                <div className="pt-2 text-right">
                  <button
                    type="button"
                    onClick={() => setShowSoundTest(true)}
                    className="text-xs text-[var(--volt)] hover:underline inline-flex items-center gap-1 min-h-[36px]"
                  >
                    <Music className="w-3.5 h-3.5" />
                    <span>Open Sound Library Audition</span>
                  </button>
                </div>
              </div>

              {/* Editable Event List */}
              <div className="pt-3 border-t border-[var(--ink-3)] space-y-3">
                <div className="flex items-center justify-between text-xs text-[var(--text-2)]">
                  <span className="font-semibold uppercase tracking-wider text-[11px]">
                    Working Event List ({events.length})
                  </span>
                  <span className="font-mono text-[11px]">
                    Tap to edit
                  </span>
                </div>

                {events.length === 0 ? (
                  <div className="p-6 text-center text-xs text-[var(--text-2)] bg-[var(--ink)] rounded-[12px] border border-[var(--ink-3)]">
                    No sound effects in timeline. Tap &quot;Add SFX&quot; above to create one.
                  </div>
                ) : (
                  <div className="max-h-[380px] overflow-y-auto space-y-2 pr-1">
                    {events.map((ev) => {
                      const isSelected = selectedEventId === ev.id;

                      return (
                        <div
                          key={ev.id}
                          onClick={() => setSelectedEventId(ev.id)}
                          className={`p-3 rounded-[10px] border transition-all cursor-pointer text-xs ${
                            isSelected
                              ? 'bg-[var(--ink-3)] border-[var(--volt)] glow-volt-border'
                              : ev.enabled
                              ? 'bg-[var(--ink)] border-[var(--ink-3)] hover:border-[var(--ink-3)]/80'
                              : 'bg-[var(--ink)]/50 border-[var(--ink-3)]/50 opacity-60'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={ev.enabled}
                                onChange={(e) =>
                                  handleUpdateEvent(ev.id, { enabled: e.target.checked })
                                }
                                onClick={(e) => e.stopPropagation()}
                                className="accent-[var(--volt)] w-4 h-4 rounded cursor-pointer shrink-0"
                              />
                              <span className="font-bold text-[var(--text)] truncate">
                                {ev.type}
                              </span>
                              <span className="px-1.5 py-0.5 rounded-[4px] bg-[var(--ink-2)] text-[10px] font-mono text-[var(--text-2)]">
                                v{ev.variant + 1}
                              </span>
                            </div>
                            <span className="font-mono font-medium text-[var(--volt)] tabular-nums shrink-0">
                              {formatEventTime(ev.time)}
                            </span>
                          </div>

                          <div className="flex items-center justify-between text-[10px] text-[var(--text-2)] font-mono pt-1">
                            <span>Intent: {ev.intent}</span>
                            <span>Vol: {Math.round(ev.volume * 100)}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {showExportModal && (
        <ExportModal
          videoBlob={rawVideoBlob}
          videoFileName={project.name}
          bundle={bundle}
          events={events}
          plan={plan}
          masterVol={masterVol}
          onClose={() => setShowExportModal(false)}
        />
      )}
    </div>
  );
}
