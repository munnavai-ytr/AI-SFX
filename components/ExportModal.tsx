'use client';

import React, { useEffect, useState, useRef } from 'react';
import { AnalysisBundle } from '@/types/analysis';
import { SfxEditEvent, SfxPlan } from '@/ai/sfx-types';
import {
  runExportPipeline,
  createSfxOnlyWavBlob,
  createMixedWavBlob,
  ExportProgress,
  ExportResult,
  ExportCancelledError,
} from '@/lib/export-engine';
import { saveExportedFile, shareExportedFile } from '@/lib/export-save';
import { formatBytes } from '@/lib/format';
import { sanitizeFileName as cleanName } from '@/lib/ffmpeg-utils';
import { useToast } from '@/components/Toast';
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  Share2,
  Music,
  Film,
  Clock,
  HardDrive,
  Sparkles,
} from 'lucide-react';

interface ExportModalProps {
  videoBlob: Blob | null;
  videoFileName: string;
  bundle: AnalysisBundle | null;
  events: SfxEditEvent[];
  plan: SfxPlan | null;
  masterVol: number;
  onClose: () => void;
}

export function ExportModal({
  videoBlob,
  videoFileName,
  bundle,
  events,
  plan,
  masterVol,
  onClose,
}: ExportModalProps) {
  const { showToast } = useToast();

  const [status, setStatus] = useState<'exporting' | 'done' | 'error' | 'cancelled'>('exporting');
  const [currentStep, setCurrentStep] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Timer & Progress
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ written: number; total: number } | null>(null);
  const [savedLocation, setSavedLocation] = useState<string | null>(null);

  const cancelRequestedRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Acquire WakeLock on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && 'wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          wakeLockRef.current = sentinel;
        })
        .catch(() => {});
    }

    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
      }
    };
  }, []);

  // Elapsed timer
  useEffect(() => {
    if (status !== 'exporting') return;
    const interval = setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  // Run Export on Mount
  useEffect(() => {
    let isCancelled = false;

    if (!videoBlob || !bundle) {
      Promise.resolve().then(() => {
        if (!isCancelled) {
          setStatus('error');
          setErrorMessage('Video file or analysis data is missing.');
        }
      });
      return;
    }

    cancelRequestedRef.current = false;

    runExportPipeline(
      videoBlob,
      videoFileName,
      bundle,
      events,
      plan,
      masterVol,
      () => cancelRequestedRef.current,
      (progressInfo) => {
        if (!isCancelled) {
          setCurrentStep(progressInfo);
        }
      }
    )
      .then((res) => {
        if (!isCancelled) {
          setExportResult(res);
          setStatus('done');
          showToast('Export complete!');
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          if (err instanceof ExportCancelledError || cancelRequestedRef.current) {
            setStatus('cancelled');
            showToast('Export cancelled');
          } else {
            setStatus('error');
            setErrorMessage((err as Error).message || 'Export failed.');
            showToast((err as Error).message, 'error');
          }
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [videoBlob, videoFileName, bundle, events, plan, masterVol, showToast]);

  const handleCancel = () => {
    cancelRequestedRef.current = true;
    setStatus('cancelled');
  };

  const outputFileName = cleanName(videoFileName);

  const handleSaveVideo = async () => {
    if (!exportResult) return;
    setIsSaving(true);
    setSaveProgress(null);
    try {
      const res = await saveExportedFile(
        exportResult.outputBlob,
        outputFileName,
        (written, total) => {
          setSaveProgress({ written, total });
        }
      );
      setSavedLocation(res.savedPath);
      showToast(`Saved to ${res.savedPath}`);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setIsSaving(false);
      setSaveProgress(null);
    }
  };

  const handleShareVideo = async () => {
    if (!exportResult) return;
    try {
      await shareExportedFile(exportResult.outputBlob, outputFileName, savedLocation || undefined);
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const handleDownloadSfxWav = async () => {
    if (!bundle) return;
    try {
      showToast('Rendering SFX audio WAV...');
      const wavBlob = await createSfxOnlyWavBlob(bundle, events, plan, masterVol);
      await saveExportedFile(wavBlob, `${outputFileName.replace('-sfx.mp4', '')}-sfx-only.wav`);
      showToast('SFX audio WAV exported');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const handleDownloadMixedWav = async () => {
    if (!videoBlob || !bundle) return;
    try {
      showToast('Rendering mixed audio WAV...');
      const wavBlob = await createMixedWavBlob(videoBlob, bundle, events, plan, masterVol);
      await saveExportedFile(wavBlob, `${outputFileName.replace('-sfx.mp4', '')}-mixed-audio.wav`);
      showToast('Mixed audio WAV exported');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const stepList = [
    { id: 'read', label: '1. Reading original audio' },
    { id: 'sfx', label: '2. Rendering sound effects' },
    { id: 'mix', label: '3. Mixing down' },
    { id: 'encode', label: '4. Encoding audio & muxing MP4' },
    { id: 'verify', label: '5. Verifying result' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in-0">
      <div className="w-full max-w-lg bg-[var(--ink-2)] border border-[var(--ink-3)] rounded-[var(--radius)] p-6 space-y-6 shadow-2xl relative">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--ink-3)] pb-4">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-[var(--volt)]" />
            <h2 className="text-base font-bold text-[var(--text)]">
              {status === 'exporting' ? 'Exporting Video with SFX' : status === 'done' ? 'Export Complete' : 'Export Video'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-[8px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-3)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Area */}
        {status === 'exporting' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
              <span className="flex items-center gap-1.5 text-[var(--volt)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Processing...</span>
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                <span>{elapsedSec}s elapsed</span>
              </span>
            </div>

            {/* Overall Progress Bar */}
            <div className="space-y-1.5">
              <div className="h-2.5 w-full bg-[var(--ink)] rounded-full overflow-hidden border border-[var(--ink-3)]">
                <div
                  className="h-full bg-[var(--volt)] transition-all duration-300"
                  style={{ width: `${Math.round((currentStep?.progress || 0) * 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-[var(--text-2)]">
                <span>{currentStep?.stepName || 'Initializing...'}</span>
                <span>{Math.round((currentStep?.progress || 0) * 100)}%</span>
              </div>
            </div>

            {/* Step Indicator Checklist */}
            <div className="space-y-2 pt-2 border-t border-[var(--ink-3)]/60 text-xs font-mono">
              {stepList.map((st) => {
                const isCurrent = currentStep?.step === st.id;
                const isPast =
                  currentStep &&
                  stepList.findIndex((s) => s.id === currentStep.step) >
                    stepList.findIndex((s) => s.id === st.id);

                return (
                  <div
                    key={st.id}
                    className={`flex items-center justify-between p-2 rounded-[8px] ${
                      isCurrent
                        ? 'bg-[var(--ink)] border border-[var(--volt)]/50 text-[var(--volt)] font-semibold'
                        : isPast
                        ? 'text-[var(--text-2)] opacity-80'
                        : 'text-[var(--text-2)]/40'
                    }`}
                  >
                    <span>{st.label}</span>
                    {isCurrent ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isPast ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[var(--volt)]" />
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Live Step Detail */}
            {currentStep?.detail && (
              <p className="text-xs font-mono text-[var(--text-2)] bg-[var(--ink)] p-3 rounded-[8px] border border-[var(--ink-3)]">
                {currentStep.detail}
              </p>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 rounded-[8px] border border-[var(--danger)]/50 text-[var(--danger)] text-xs font-semibold hover:bg-[var(--danger)]/10 min-h-[40px]"
              >
                Cancel Export
              </button>
            </div>
          </div>
        )}

        {status === 'done' && exportResult && (
          <div className="space-y-5">
            <div className="p-4 rounded-[12px] bg-[var(--ink)] border border-[var(--volt)]/60 space-y-3">
              <div className="flex items-center gap-2 text-[var(--volt)]">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-bold text-sm">Video Ready</span>
              </div>
              <p className="text-xs text-[var(--text-2)] font-mono">
                {exportResult.verificationMessage}
              </p>
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-[var(--text-2)] pt-1 border-t border-[var(--ink-3)]">
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3.5 h-3.5 text-[var(--volt)]" />
                  <span>Size: {formatBytes(exportResult.outputBlob.size)}</span>
                </span>
                <span>·</span>
                <span className="text-[var(--volt)]">
                  Peak: {exportResult.peakDb} dBFS
                </span>
                <span>·</span>
                <span>Duration: {exportResult.duration.toFixed(1)}s</span>
              </div>
            </div>

            {/* Saved Location Badge */}
            {savedLocation && (
              <div className="p-3 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs font-mono text-[var(--text-2)] truncate">
                <span className="text-[var(--volt)] font-bold">Saved:</span> {savedLocation}
              </div>
            )}

            {/* Save & Share Action Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleSaveVideo}
                disabled={isSaving}
                className="w-full px-4 py-3 rounded-[10px] bg-[var(--volt)] text-[var(--volt-ink)] font-bold text-xs hover:opacity-95 transition-all inline-flex items-center justify-center gap-2 min-h-[44px]"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span>
                  {isSaving
                    ? saveProgress
                      ? `Saving ${Math.round((saveProgress.written / saveProgress.total) * 100)}%`
                      : 'Saving...'
                    : 'Save Video'}
                </span>
              </button>

              <button
                type="button"
                onClick={handleShareVideo}
                className="w-full px-4 py-3 rounded-[10px] bg-[var(--ink-3)] text-[var(--text)] font-semibold text-xs border border-[var(--ink-3)] hover:border-[var(--volt)] transition-colors inline-flex items-center justify-center gap-2 min-h-[44px]"
              >
                <Share2 className="w-4 h-4 text-[var(--volt)]" />
                <span>Share Video</span>
              </button>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <div className="p-4 rounded-[12px] bg-[var(--ink)] border border-[var(--danger)]/50 space-y-2 text-xs">
              <div className="flex items-center gap-2 text-[var(--danger)] font-bold text-sm">
                <AlertCircle className="w-5 h-5" />
                <span>Export Failed</span>
              </div>
              <p className="text-[var(--text-2)]">{errorMessage}</p>
            </div>
          </div>
        )}

        {status === 'cancelled' && (
          <div className="space-y-4">
            <div className="p-4 rounded-[12px] bg-[var(--ink)] border border-[var(--ink-3)] space-y-2 text-xs text-center text-[var(--text-2)]">
              <p className="font-semibold text-[var(--text)]">Export was cancelled by user.</p>
            </div>
          </div>
        )}

        {/* Fallback WAV Export Options (Always available) */}
        <div className="pt-4 border-t border-[var(--ink-3)] space-y-2">
          <span className="text-[11px] font-mono text-[var(--text-2)] block">
            Audio Fallback Downloads (WAV)
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleDownloadSfxWav}
              className="px-3 py-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] hover:border-[var(--volt)] text-xs text-[var(--text-2)] hover:text-[var(--text)] transition-colors inline-flex items-center gap-1.5 min-h-[36px]"
            >
              <Music className="w-3.5 h-3.5 text-[var(--volt)]" />
              <span>Export SFX Audio Only</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadMixedWav}
              className="px-3 py-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] hover:border-[var(--volt)] text-xs text-[var(--text-2)] hover:text-[var(--text)] transition-colors inline-flex items-center gap-1.5 min-h-[36px]"
            >
              <Film className="w-3.5 h-3.5 text-[var(--volt)]" />
              <span>Export Mixed Audio Only</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
