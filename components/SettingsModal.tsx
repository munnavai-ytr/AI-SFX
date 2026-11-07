'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useKeyStore } from '@/stores/use-key-store';
import { useToast } from '@/components/Toast';
import {
  X,
  Key,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Cpu,
  RefreshCw,
  Activity,
  Music,
  Zap,
} from 'lucide-react';
import {
  discoverGeminiModels,
  getSelectedModel,
  setSelectedModel,
  getAiCallsToday,
  testAiSpeed,
} from '@/ai/gemini';
import { ApiKeyManager } from '@/components/ApiKeyManager';
import { SfxTestScreen } from '@/components/SfxTestScreen';

import { useShallow } from 'zustand/react/shallow';

import { formatBytes } from '@/lib/format';

export function SettingsModal() {
  const {
    isSettingsOpen,
    closeSettings,
    clearAllData,
  } = useAppStore(
    useShallow((s) => ({
      isSettingsOpen: s.isSettingsOpen,
      closeSettings: s.closeSettings,
      clearAllData: s.clearAllData,
    }))
  );

  const { slots } = useKeyStore(
    useShallow((s) => ({
      slots: s.slots,
    }))
  );

  const { showToast } = useToast();

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [showSoundTest, setShowSoundTest] = useState(false);

  // Model selection & discovery state
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState<string>(() => getSelectedModel());
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const aiCallsToday = getAiCallsToday();
  const [storageUsage, setStorageUsage] = useState<{ used: number; quota: number } | null>(null);

  // Speed test state
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [speedTestResult, setSpeedTestResult] = useState<{ latencyMs: number; modelUsed: string } | null>(null);
  const [speedTestError, setSpeedTestError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        setStorageUsage({
          used: est.usage || 0,
          quota: est.quota || 0,
        });
      });
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    discoverGeminiModels(undefined, false)
      .then((m) => {
        setModels(m);
      })
      .catch(() => {
        // ignore initial load failure
      });
  }, [slots]);

  if (!isSettingsOpen) return null;

  if (showSoundTest) {
    return (
      <div className="fixed inset-0 z-50 bg-[var(--ink)] overflow-y-auto">
        <SfxTestScreen onBack={() => setShowSoundTest(false)} />
      </div>
    );
  }

  const handleClearAll = async () => {
    setIsClearing(true);
    try {
      await clearAllData();
      setShowClearConfirm(false);
      showToast('All projects, video files, and SFX plans have been cleared.');
    } catch (err) {
      showToast(`Failed to clear data: ${(err as Error).message}`, 'error');
    } finally {
      setIsClearing(false);
    }
  };

  const handleModelChange = (model: string) => {
    setCurrentModel(model);
    setSelectedModel(model);
  };

  const handleRefreshModels = async () => {
    const hasEnabledKey = slots.some((s) => s.enabled && !s.invalid);
    if (!hasEnabledKey) {
      showToast('Add or enable an API key first to discover models.', 'error');
      return;
    }
    setIsRefreshingModels(true);
    try {
      const refreshed = await discoverGeminiModels(undefined, true);
      setModels(refreshed);
      showToast(`Refreshed: ${refreshed.length} Gemini models discovered.`);
    } catch (err) {
      showToast(`Failed to discover models: ${(err as Error).message}`, 'error');
    } finally {
      setIsRefreshingModels(false);
    }
  };

  const handleTestSpeed = async () => {
    const hasEnabledKey = slots.some((s) => s.enabled && !s.invalid);
    if (!hasEnabledKey) {
      showToast('Add or enable an API key first to test AI speed.', 'error');
      return;
    }
    setIsTestingSpeed(true);
    setSpeedTestResult(null);
    setSpeedTestError(null);
    try {
      const res = await testAiSpeed(undefined, currentModel);
      setSpeedTestResult(res);
      showToast(`Speed test passed: ${res.latencyMs} ms (${res.modelUsed})`);
    } catch (err) {
      const msg = (err as Error).message || 'Speed test failed';
      setSpeedTestError(msg);
      showToast(msg, 'error');
    } finally {
      setIsTestingSpeed(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-xs transition-opacity"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      <div
        className="w-full max-w-lg bg-[var(--ink-2)] border border-[var(--ink-3)] rounded-t-[20px] sm:rounded-[var(--radius)] max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150 safe-padding-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ink-3)]">
          <div className="flex items-center gap-2.5">
            <Key className="w-5 h-5 text-[var(--volt)]" />
            <h2 id="settings-modal-title" className="text-base font-semibold tracking-tight text-[var(--text)]">
              Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={closeSettings}
            aria-label="Close settings"
            className="w-10 h-10 flex items-center justify-center rounded-[8px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-3)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Multi-Key BYOK Manager */}
          <ApiKeyManager />

          {/* Model Selector & API Usage Section */}
          <div className="border-t border-[var(--ink-3)] pt-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[var(--volt)]" />
                <h3 className="text-sm font-semibold text-[var(--text)]">Gemini Model</h3>
              </div>
              <button
                type="button"
                onClick={handleRefreshModels}
                disabled={isRefreshingModels || slots.length === 0}
                className="px-2.5 py-1.5 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs font-medium text-[var(--text-2)] hover:text-[var(--text)] hover:border-[var(--volt)] transition-colors inline-flex items-center gap-1.5 disabled:opacity-40 min-h-[36px]"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingModels ? 'animate-spin text-[var(--volt)]' : ''}`} />
                <span>Refresh models</span>
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="model-select" className="text-xs text-[var(--text-2)] block">
                  Selected model (Auto chooses highest ranked Flash model)
                </label>
                <button
                  type="button"
                  onClick={handleTestSpeed}
                  disabled={isTestingSpeed || slots.length === 0}
                  className="px-2.5 py-1 rounded-[6px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs text-[var(--volt)] font-mono hover:border-[var(--volt)] transition-colors inline-flex items-center gap-1.5 disabled:opacity-40 min-h-[32px]"
                >
                  <Zap className={`w-3.5 h-3.5 ${isTestingSpeed ? 'animate-pulse' : ''}`} />
                  <span>{isTestingSpeed ? 'Testing speed...' : 'Test AI speed'}</span>
                </button>
              </div>
              <select
                id="model-select"
                value={currentModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full bg-[var(--ink)] border border-[var(--ink-3)] rounded-[10px] px-3.5 py-2.5 text-xs text-[var(--text)] font-mono focus:border-[var(--volt)] focus:outline-none transition-colors min-h-[44px]"
              >
                <option value="auto">Auto (Best ranked model)</option>
                {models.map((m) => {
                  const label = m.replace(/^models\//, '');
                  return (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  );
                })}
              </select>

              {/* Speed Test Results Display */}
              {speedTestResult && (
                <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--volt)]/50 text-xs font-mono text-[var(--volt)] flex items-center justify-between animate-in fade-in-0">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Speed Test: {speedTestResult.latencyMs} ms</span>
                  </span>
                  <span className="text-[var(--text-2)] text-[11px] truncate max-w-[180px]">
                    {speedTestResult.modelUsed.replace(/^models\//, '')}
                  </span>
                </div>
              )}

              {speedTestError && (
                <div className="p-2.5 rounded-[8px] bg-[var(--ink)] border border-[var(--danger)]/50 text-xs font-mono text-[var(--danger)] flex items-center gap-1.5 animate-in fade-in-0">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{speedTestError}</span>
                </div>
              )}
            </div>

            {/* AI Calls Today Counter */}
            <div className="flex items-center justify-between p-3 rounded-[10px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs">
              <div className="flex items-center gap-2 text-[var(--text-2)]">
                <Activity className="w-4 h-4 text-[var(--volt)]" />
                <span>API Usage</span>
              </div>
              <span className="font-mono font-medium text-[var(--text)]">
                AI calls today: {aiCallsToday}
              </span>
            </div>

            {/* Sound Library Audition Button */}
            <div className="pt-1 flex justify-end">
              <button
                type="button"
                onClick={() => setShowSoundTest(true)}
                className="text-xs text-[var(--volt)] hover:underline inline-flex items-center gap-1.5 font-medium py-1"
              >
                <Music className="w-3.5 h-3.5" />
                <span>Sound test (Audition all 30 sounds)</span>
              </button>
            </div>
          </div>

            {/* Honest Privacy Notice */}
            <div className="p-3 rounded-[10px] bg-[var(--ink)] border border-[var(--volt)]/40 text-xs text-[var(--text-2)] space-y-1">
              <span className="text-[var(--volt)] font-bold block">Privacy &amp; Data Guarantee</span>
              <p className="leading-normal text-[11px]">
                Your video stays on your device. For analysis only, small preview frames and a low-quality audio copy are sent to Google Gemini using your API key.
              </p>
            </div>

            {/* Data Storage Section & About Info */}
            <div className="border-t border-[var(--ink-3)] pt-6 space-y-4">
              <h3 className="text-sm font-semibold text-[var(--text)]">About &amp; Storage</h3>
              <div className="p-3 rounded-[10px] bg-[var(--ink)] border border-[var(--ink-3)] space-y-2 text-xs font-mono text-[var(--text-2)]">
                <div className="flex justify-between">
                  <span>Version</span>
                  <span className="text-[var(--text)]">0.1.0</span>
                </div>
                <div className="flex justify-between">
                  <span>Build Date</span>
                  <span className="text-[var(--text)]">2026-11-06</span>
                </div>
                <div className="flex justify-between">
                  <span>AI Calls Today</span>
                  <span className="text-[var(--volt)]">{aiCallsToday}</span>
                </div>
                <div className="flex justify-between border-t border-[var(--ink-3)] pt-2">
                  <span>Storage Usage</span>
                  <span className="text-[var(--text)]">
                    {storageUsage ? `${formatBytes(storageUsage.used)} / ${formatBytes(storageUsage.quota)}` : 'Calculating...'}
                  </span>
                </div>
              </div>

              {showClearConfirm ? (
                <div className="bg-[var(--ink)] border border-[var(--danger)]/40 rounded-[12px] p-4 space-y-3">
                  <p className="text-xs text-[var(--text)] font-medium">
                    Are you sure? This will permanently delete all projects and saved video files from your browser.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleClearAll}
                      disabled={isClearing}
                      className="px-4 py-2 rounded-[8px] bg-[var(--danger)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity min-h-[44px] flex items-center justify-center gap-1.5"
                    >
                      {isClearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      Yes, delete everything
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowClearConfirm(false)}
                      disabled={isClearing}
                      className="px-4 py-2 rounded-[8px] bg-[var(--ink-3)] text-[var(--text)] text-xs font-medium hover:bg-[var(--ink-3)]/80 transition-colors min-h-[44px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(true)}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-[10px] border border-[var(--danger)]/30 text-[var(--danger)] text-xs font-semibold hover:bg-[var(--danger)]/10 transition-colors inline-flex items-center justify-center gap-2 min-h-[44px]"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear all data
                </button>
              )}
            </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--ink-3)] bg-[var(--ink-2)] flex justify-end">
          <button
            type="button"
            onClick={closeSettings}
            className="w-full sm:w-auto px-5 py-2.5 rounded-[10px] bg-[var(--volt)] text-[var(--volt-ink)] text-sm font-semibold hover:opacity-95 transition-opacity min-h-[44px]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
