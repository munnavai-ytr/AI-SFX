'use client';

import React, { useState } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useToast } from '@/components/Toast';
import { X, Eye, EyeOff, Key, Trash2, CheckCircle2, AlertCircle, Loader2, ExternalLink } from 'lucide-react';

export function SettingsModal() {
  const {
    isSettingsOpen,
    closeSettings,
    apiKey,
    setApiKey,
    testApiKey,
    keyTestState,
    clearAllData,
  } = useAppStore();

  const { showToast } = useToast();

  const [showPassword, setShowPassword] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  if (!isSettingsOpen) return null;

  const handleClearAll = async () => {
    setIsClearing(true);
    try {
      await clearAllData();
      setShowClearConfirm(false);
      showToast('All projects and video files have been cleared.');
    } catch (err) {
      showToast(`Failed to clear data: ${(err as Error).message}`, 'error');
    } finally {
      setIsClearing(false);
    }
  };

  const formattedTestDate = keyTestState.testedAt
    ? new Date(keyTestState.testedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

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
          {/* Gemini API Key section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label htmlFor="gemini-key-input" className="text-sm font-medium text-[var(--text)]">
                Gemini API Key
              </label>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[var(--volt)] hover:underline inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 sm:py-1 py-2"
              >
                <span>Get a free key at aistudio.google.com/apikey</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="relative flex items-center">
              <input
                id="gemini-key-input"
                type={showPassword ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIzaSy..."
                autoComplete="off"
                spellCheck="false"
                className="w-full bg-[var(--ink)] border border-[var(--ink-3)] rounded-[12px] px-4 py-3 pr-12 text-sm text-[var(--text)] placeholder-[var(--text-2)]/50 focus:border-[var(--volt)] focus:outline-none transition-colors min-h-[44px] font-mono"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide API key' : 'Show API key'}
                className="absolute right-2 w-10 h-10 flex items-center justify-center text-[var(--text-2)] hover:text-[var(--text)] rounded-[8px] transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {/* Test button and test feedback */}
            <div className="pt-1 flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                type="button"
                onClick={testApiKey}
                disabled={keyTestState.testing || !apiKey.trim()}
                className="px-4 py-2.5 rounded-[10px] bg-[var(--ink-3)] text-[var(--text)] text-xs font-semibold hover:bg-[var(--ink-3)]/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all inline-flex items-center justify-center gap-2 min-h-[44px]"
              >
                {keyTestState.testing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--volt)]" />
                    <span>Testing key...</span>
                  </>
                ) : (
                  <span>Test key</span>
                )}
              </button>

              {keyTestState.tested && (
                <div className="flex-1 text-xs">
                  {keyTestState.valid ? (
                    <div className="flex items-center gap-1.5 text-[var(--volt)]">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span className="font-medium">
                        Key works · {keyTestState.modelCount ?? 0} models available
                        {formattedTestDate && ` (${formattedTestDate})`}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 text-[var(--danger)]">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span className="leading-snug">
                        {keyTestState.error || 'Key validation failed.'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-[var(--ink-3)] pt-6">
            <h3 className="text-sm font-semibold text-[var(--text)] mb-1">Data Storage</h3>
            <p className="text-xs text-[var(--text-2)] mb-4 leading-relaxed">
              Video files and project metadata are stored exclusively inside your browser&apos;s IndexedDB. No videos or keys are uploaded to any server.
            </p>

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
