import React, { useState, useEffect, useRef } from 'react';
import { useAnalysisStore, StepStatus } from '@/stores/use-analysis-store';
import { useAppStore } from '@/stores/use-app-store';
import { useKeyStore } from '@/stores/use-key-store';
import { useToast } from '@/components/Toast';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  MinusCircle,
  RotateCcw,
  Play,
  Wand2,
} from 'lucide-react';

function formatElapsed(startedAt?: number, endedAt?: number, currentTime?: number): string | null {
  if (!startedAt) return null;
  const end = endedAt || currentTime || startedAt;
  const elapsedMs = Math.max(0, end - startedAt);
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${seconds}s`;
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-5 h-5 text-[var(--volt)] animate-spin shrink-0" />;
    case 'done':
      return <CheckCircle2 className="w-5 h-5 text-[var(--volt)] shrink-0" />;
    case 'failed':
      return <AlertCircle className="w-5 h-5 text-[var(--danger)] shrink-0" />;
    case 'skipped':
      return <MinusCircle className="w-5 h-5 text-[var(--text-2)] shrink-0" />;
    case 'pending':
    default:
      return <Clock className="w-5 h-5 text-[var(--text-2)]/50 shrink-0" />;
  }
}

/**
 * Timer hook using useState & useEffect instead of unstable getSnapshot in useSyncExternalStore.
 */
function useCurrentTime(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => (active ? Date.now() : 0));

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return active ? now : 0;
}

export function AnalyzingScreen() {
  const { steps, running, cancelRequested, requestCancel } = useAnalysisStore(
    useShallow((s) => ({
      steps: s.steps,
      running: s.running,
      cancelRequested: s.cancelRequested,
      requestCancel: s.requestCancel,
    }))
  );

  const { activeProjectId, projects, setScreen } = useAppStore(
    useShallow((s) => ({
      activeProjectId: s.activeProjectId,
      projects: s.projects,
      setScreen: s.setScreen,
    }))
  );

  const { showToast } = useToast();
  const lastSwitch = useKeyStore((s) => s.lastSwitch);
  const lastSwitchRef = useRef<number>(0);

  useEffect(() => {
    if (lastSwitch && lastSwitch.at > lastSwitchRef.current) {
      lastSwitchRef.current = lastSwitch.at;
      showToast(
        `${lastSwitch.fromLabel} hit its limit — switched to ${lastSwitch.toLabel} (${lastSwitch.ms} ms)`
      );
    }
  }, [lastSwitch, showToast]);

  const currentTime = useCurrentTime(running, 250);
  const project = projects.find((p) => p.id === activeProjectId);

  const isCancelled = cancelRequested && !running;

  const handleRunFullPipeline = async () => {
    if (!project) return;
    try {
      const { runAnalysisEngine } = await import('@/analysis/engine');
      const result = await runAnalysisEngine(project, { forceReanalyze: true });
      if (result) {
        setScreen('studio');
      }
    } catch (err) {
      console.error('Analysis execution failed:', err);
    }
  };

  const handleUseRuleBasedFallback = async () => {
    if (!project) return;
    try {
      const { applyRuleBasedFallback } = await import('@/analysis/engine');
      const res = await applyRuleBasedFallback(project.id);
      if (res) {
        showToast('Rule-based sound effects placed on timeline');
        setScreen('studio');
      }
    } catch (err: any) {
      console.error('Failed to generate rule-based fallback:', err);
      showToast(err?.message || 'Rule-based generation failed');
    }
  };

  // If the store has no run
  if (steps.length === 0) {
    return (
      <div className="min-h-screen bg-[var(--ink)] text-[var(--text)] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-[var(--ink-2)] border border-[var(--ink-3)] flex items-center justify-center text-[var(--text-2)] mb-4">
          <Clock className="w-6 h-6" />
        </div>
        <h1 className="text-lg font-bold text-[var(--text)] mb-2">No analysis is running</h1>
        <p className="text-xs text-[var(--text-2)] max-w-sm mb-6 leading-relaxed">
          Select a project from your workspace to run video analysis and generate sound effects.
        </p>
        <button
          type="button"
          onClick={() => setScreen('home')}
          className="px-5 py-2.5 rounded-[10px] bg-[var(--volt)] text-[var(--volt-ink)] text-sm font-semibold hover:opacity-95 transition-opacity min-h-[44px] inline-flex items-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Projects
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ink)] text-[var(--text)]">
      {/* Header */}
      <header className="border-b border-[var(--ink-3)] safe-padding-top px-4 sm:px-8 py-3.5 bg-[var(--ink)] sticky top-0 z-20">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setScreen('studio')}
              aria-label="Back to studio"
              className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-base font-bold tracking-tight text-[var(--text)]">
                Video Analysis
              </h1>
              <p className="text-xs text-[var(--text-2)] font-mono">
                {running
                  ? cancelRequested
                    ? 'Cancelling...'
                    : 'Processing in browser'
                  : isCancelled
                  ? 'Analysis cancelled'
                  : 'Finished'}
              </p>
            </div>
          </div>

          {running && (
            <button
              type="button"
              onClick={requestCancel}
              disabled={cancelRequested}
              className="px-4 py-2 rounded-[8px] border border-[var(--ink-3)] text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] hover:border-[var(--danger)]/50 hover:bg-[var(--danger)]/10 transition-colors disabled:opacity-50 min-h-[44px]"
            >
              {cancelRequested ? 'Cancelling...' : 'Cancel'}
            </button>
          )}

          {isCancelled && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setScreen('studio')}
                className="px-3.5 py-1.5 rounded-[8px] border border-[var(--ink-3)] text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] transition-colors min-h-[40px]"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleRunFullPipeline}
                className="px-3.5 py-1.5 rounded-[8px] bg-[var(--volt)] text-[var(--volt-ink)] text-xs font-semibold hover:opacity-95 transition-opacity min-h-[40px] inline-flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" />
                Start again
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main step list */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-8 py-6 sm:py-8 safe-padding-bottom space-y-4">
        {/* Cancelled notice banner */}
        {isCancelled && (
          <div className="p-4 rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--text)]">Analysis cancelled</p>
              <p className="text-xs text-[var(--text-2)]">You stopped the video analysis process.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setScreen('studio')}
                className="px-3.5 py-1.5 rounded-[8px] border border-[var(--ink-3)] text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] transition-colors min-h-[38px]"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleRunFullPipeline}
                className="px-3.5 py-1.5 rounded-[8px] bg-[var(--volt)] text-[var(--volt-ink)] text-xs font-semibold hover:opacity-95 transition-opacity min-h-[38px] inline-flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" />
                Start again
              </button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {steps.map((step) => {
            const elapsed = formatElapsed(
              step.startedAt,
              step.endedAt,
              step.status === 'running' ? currentTime : undefined
            );

            return (
              <div
                key={step.id}
                className={`p-4 rounded-[12px] bg-[var(--ink-2)] border transition-all ${
                  step.status === 'running'
                    ? 'border-[var(--volt)]/50 glow-volt-border'
                    : step.status === 'failed'
                    ? 'border-[var(--danger)]/50'
                    : 'border-[var(--ink-3)]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <StatusIcon status={step.status} />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-sm font-semibold text-[var(--text)] leading-tight">
                          {step.label}
                        </h2>

                        {/* AI Step: Active Key Chip */}
                        {step.id === 'ai' && step.status === 'running' && (() => {
                          const match = step.detail?.match(/(Key\s*\d+)\s*·\s*model\s*([^\s·(]+)/i);
                          if (match) {
                            return (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--volt)]/15 border border-[var(--volt)]/40 text-[var(--volt)]">
                                {match[1]} · {match[2].replace(/^models\//, '')}
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {step.detail && (
                        <p className={`text-xs mt-1 font-mono leading-relaxed ${
                          step.detail.includes('->')
                            ? 'text-[var(--volt)] font-medium animate-pulse'
                            : 'text-[var(--text-2)]'
                        }`}>
                          {step.detail}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {elapsed && (
                      <span className="text-xs text-[var(--text-2)] font-mono tabular-nums">
                        {elapsed}
                      </span>
                    )}

                    {step.status === 'failed' && (
                      <div className="flex items-center gap-2 flex-wrap">
                        {step.id === 'ai' && (
                          <button
                            type="button"
                            onClick={handleUseRuleBasedFallback}
                            className="px-3 py-1.5 rounded-[6px] bg-[var(--volt)] text-[var(--volt-ink)] text-xs font-bold hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 min-h-[36px]"
                          >
                            <Wand2 className="w-3.5 h-3.5" />
                            Use rule-based suggestions
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleRunFullPipeline}
                          className="px-3 py-1.5 rounded-[6px] bg-[var(--ink-3)] text-xs font-medium text-[var(--text)] hover:bg-[var(--ink-3)]/80 inline-flex items-center gap-1.5 min-h-[36px]"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Progress rendering: ONLY real percentages, or indeterminate spinner */}
                {step.status === 'running' && (
                  <div className="mt-3 pt-3 border-t border-[var(--ink-3)]/60">
                    {typeof step.progress === 'number' ? (
                      <div className="space-y-1">
                        <div className="flex justify-between text-[11px] font-mono text-[var(--text-2)] tabular-nums">
                          <span>Progress</span>
                          <span>{Math.round(step.progress * 100)}%</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-[var(--ink-3)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--volt)] transition-all duration-200"
                            style={{ width: `${Math.min(100, Math.max(0, step.progress * 100))}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-[var(--text-2)] font-mono">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--volt)]" />
                        <span>Processing step...</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Failed error message */}
                {step.status === 'failed' && step.error && (
                  <div className="mt-3 p-3 rounded-[8px] bg-[var(--ink)] border border-[var(--danger)]/30 text-xs text-[var(--danger)] leading-relaxed">
                    {step.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
