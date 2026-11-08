'use client';

import React, { useState, useEffect } from 'react';
import { useKeyStore, AttemptLog } from '@/stores/use-key-store';
import { SlotId, KeySlot, validateRawKey, maskKey } from '@/ai/keyvault';
import { discoverGeminiModels } from '@/ai/gemini';
import { normalizeModelName, makeCooldownKey, nextMidnightPacific } from '@/ai/key-scheduler';
import { useToast } from '@/components/Toast';
import {
  Key,
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Zap,
  ShieldAlert,
  Loader2,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return 'never';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${Math.floor(diffHour / 24)}d ago`;
}

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function ApiKeyManager() {
  const {
    slots,
    cooldowns,
    isInsecure,
    attempts,
    autoRetryWhenBusy,
    simulatedFailures,
    addKey,
    replaceKey,
    removeKey,
    setEnabled,
    setSlotTested,
    setAutoRetryWhenBusy,
    setSimulatedFailure,
  } = useKeyStore();

  const { showToast } = useToast();

  // Ticker for live cooldown countdowns
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Modal / Inline form for Add or Replace
  const [editingSlotId, setEditingSlotId] = useState<SlotId | null>(null);
  const [isReplacing, setIsReplacing] = useState(false);
  const [rawKeyInput, setRawKeyInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Individual testing state
  const [testingSlotId, setTestingSlotId] = useState<SlotId | null>(null);
  const [isTestingAll, setIsTestingAll] = useState(false);

  // Collapsible panels
  const [showAttempts, setShowAttempts] = useState(false);
  const [showSimulate, setShowSimulate] = useState(false);

  const slotIds: SlotId[] = ['k1', 'k2', 'k3'];

  const getSlot = (id: SlotId): KeySlot | undefined => slots.find((s) => s.id === id);

  // Calculate cooling status for a slot across models
  const getSlotCooldownStatus = (slot: KeySlot) => {
    const activeEntries: { model: string; until: number; reason: string }[] = [];
    for (const [k, v] of Object.entries(cooldowns)) {
      if (k.startsWith(`${slot.id}|`) && v && v.until > now) {
        const model = k.split('|')[1];
        activeEntries.push({ model, until: v.until, reason: v.reason });
      }
    }

    if (activeEntries.length === 0) return null;

    activeEntries.sort((a, b) => b.until - a.until);
    return activeEntries[0];
  };

  const handleOpenAddOrReplace = (slotId: SlotId, replace = false) => {
    setEditingSlotId(slotId);
    setIsReplacing(replace);
    setRawKeyInput('');
    const existing = getSlot(slotId);
    setLabelInput(existing ? existing.label : `Key ${slotId.replace('k', '')}`);
    setInputError(null);
  };

  const handleCancelEdit = () => {
    setEditingSlotId(null);
    setRawKeyInput('');
    setInputError(null);
  };

  const handleSaveKey = async () => {
    if (!editingSlotId) return;

    const val = validateRawKey(rawKeyInput, editingSlotId);
    if (!val.valid) {
      setInputError(val.error || 'Invalid key format');
      return;
    }

    setIsSubmitting(true);
    setInputError(null);

    try {
      // Real test before saving as valid: GET ListModels
      const models = await discoverGeminiModels(val.cleanKey, true);
      if (isReplacing) {
        await replaceKey(editingSlotId, val.cleanKey);
        setSlotTested(editingSlotId, true, models.length);
      } else {
        await addKey(editingSlotId, labelInput, val.cleanKey);
        setSlotTested(editingSlotId, true, models.length);
      }

      showToast(`Key works · ${models.length} models available`);
      setEditingSlotId(null);
      setRawKeyInput('');
    } catch (err) {
      const msg = (err as Error).message || 'API key test failed';
      setInputError(msg);
      showToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTestSlot = async (slotId: SlotId) => {
    const slot = getSlot(slotId);
    if (!slot) return;

    setTestingSlotId(slotId);
    try {
      const { getKeySync } = await import('@/ai/keyvault');
      const rawKey = getKeySync(slotId);
      if (!rawKey) {
        throw new Error('Key not loaded');
      }

      const models = await discoverGeminiModels(rawKey, true);
      setSlotTested(slotId, true, models.length);
      showToast(`${slot.label} works · ${models.length} models available`);
    } catch (err) {
      const msg = (err as Error).message || 'Test failed';
      setSlotTested(slotId, false, undefined, msg);
      showToast(`${slot.label} failed: ${msg}`, 'error');
    } finally {
      setTestingSlotId(null);
    }
  };

  const handleTestAllKeys = async () => {
    setIsTestingAll(true);
    let okCount = 0;
    const { getKeySync } = await import('@/ai/keyvault');

    for (const slot of slots.filter((s) => s.enabled)) {
      try {
        const raw = getKeySync(slot.id);
        if (raw) {
          const models = await discoverGeminiModels(raw, true);
          setSlotTested(slot.id, true, models.length);
          okCount++;
        }
      } catch (err) {
        setSlotTested(slot.id, false, undefined, (err as Error).message);
      }
    }

    setIsTestingAll(false);
    showToast(`Tested all keys: ${okCount} ready.`);
  };

  const readySlotsCount = slots.filter((s) => {
    if (!s.enabled || s.invalid) return false;
    const cd = getSlotCooldownStatus(s);
    return !cd;
  }).length;

  const totalSlotsCount = slots.length;

  return (
    <div className="space-y-4">
      {/* Insecure context warning */}
      {isInsecure && (
        <div className="p-3 rounded-[10px] bg-[var(--ink)] border border-[var(--danger)]/50 text-xs text-[var(--danger)] flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>Keys are stored without encryption on this device</span>
        </div>
      )}

      {/* Header bar: "API keys" + "2 of 3 ready ●" */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-[var(--volt)]" />
          <h3 className="text-sm font-semibold text-[var(--text)]">API keys</h3>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="text-[var(--text-2)]">
            {readySlotsCount} of {totalSlotsCount} ready
          </span>
          <span
            className={`w-2 h-2 rounded-full ${
              readySlotsCount > 0 ? 'bg-[var(--volt)]' : 'bg-[var(--danger)]'
            }`}
          />
        </div>
      </div>

      {/* Slots List */}
      <div className="space-y-3">
        {slotIds.map((slotId) => {
          const slot = getSlot(slotId);
          const isEditing = editingSlotId === slotId;
          const isTesting = testingSlotId === slotId;
          const cd = slot ? getSlotCooldownStatus(slot) : null;

          if (isEditing) {
            return (
              <div
                key={slotId}
                className="p-4 rounded-[12px] bg-[var(--ink)] border border-[var(--volt)] space-y-3 animate-in fade-in-0 duration-150"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--text)]">
                    {isReplacing ? `Replace ${slot?.label || slotId}` : `Add Key to ${slotId.toUpperCase()}`}
                  </span>
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-[var(--volt)] hover:underline inline-flex items-center gap-1"
                  >
                    <span>Get key</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>

                {!isReplacing && (
                  <div>
                    <label className="text-[11px] text-[var(--text-2)] block mb-1">
                      Key Label
                    </label>
                    <input
                      type="text"
                      value={labelInput}
                      onChange={(e) => setLabelInput(e.target.value)}
                      placeholder={`Key ${slotId.replace('k', '')}`}
                      className="w-full bg-[var(--ink-2)] border border-[var(--ink-3)] rounded-[8px] px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--volt)] focus:outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="text-[11px] text-[var(--text-2)] block mb-1">
                    API Key (paste secret here)
                  </label>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck="false"
                    value={rawKeyInput}
                    onChange={(e) => setRawKeyInput(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full bg-[var(--ink-2)] border border-[var(--ink-3)] rounded-[8px] px-3 py-2 text-xs text-[var(--text)] font-mono focus:border-[var(--volt)] focus:outline-none"
                  />
                  <p className="text-[10px] text-[var(--text-2)] mt-1">
                    Tested immediately via ListModels. Never shown in plain text after saving.
                  </p>
                </div>

                {inputError && (
                  <div className="p-2.5 rounded-[6px] bg-[var(--ink-2)] border border-[var(--danger)]/50 text-[11px] text-[var(--danger)] flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{inputError}</span>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    disabled={isSubmitting}
                    className="px-3 py-1.5 rounded-[8px] border border-[var(--ink-3)] text-xs text-[var(--text-2)] hover:text-[var(--text)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveKey}
                    disabled={isSubmitting || !rawKeyInput.trim()}
                    className="px-4 py-1.5 rounded-[8px] bg-[var(--volt)] text-[var(--volt-ink)] text-xs font-semibold hover:opacity-95 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Testing &amp; Saving...</span>
                      </>
                    ) : (
                      <span>Save key</span>
                    )}
                  </button>
                </div>
              </div>
            );
          }

          if (!slot) {
            // Unset slot: [Key 3 — not set — [+ Add key]]
            return (
              <div
                key={slotId}
                className="p-3 rounded-[12px] bg-[var(--ink)] border border-dashed border-[var(--ink-3)] flex items-center justify-between"
              >
                <div className="flex items-center gap-2 text-xs text-[var(--text-2)]">
                  <span className="font-semibold text-[var(--text-2)]">
                    Key {slotId.replace('k', '')}
                  </span>
                  <span>— not set —</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleOpenAddOrReplace(slotId, false)}
                  className="px-3 py-1 rounded-[8px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-xs text-[var(--volt)] font-medium hover:border-[var(--volt)] transition-colors inline-flex items-center gap-1 min-h-[34px]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add key</span>
                </button>
              </div>
            );
          }

          // Configured slot
          const coolingRemainingSec = cd ? Math.max(1, Math.ceil((cd.until - now) / 1000)) : 0;
          const isDaily = cd?.reason === 'daily';

          return (
            <div
              key={slotId}
              className={`p-3.5 rounded-[12px] bg-[var(--ink)] border transition-all ${
                slot.invalid
                  ? 'border-[var(--danger)]/50'
                  : cd
                  ? 'border-[var(--ink-3)]'
                  : 'border-[var(--ink-3)] hover:border-[var(--volt)]/40'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                {/* Left: label, masked key, status chip */}
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-xs font-bold text-[var(--text)]">
                    {slot.label}
                  </span>
                  <span className="text-xs font-mono text-[var(--text-2)]">
                    ••••••••{slot.last4}
                  </span>

                  {/* Status chip */}
                  {!slot.enabled ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--ink-3)]/60 text-[var(--text-2)]">
                      Off
                    </span>
                  ) : slot.invalid ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--danger)]/15 border border-[var(--danger)]/40 text-[var(--danger)] inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]" />
                      <span>Invalid</span>
                    </span>
                  ) : cd ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--ink-3)] text-[var(--text-2)] inline-flex items-center gap-1">
                      <Clock className="w-3 h-3 text-[var(--text-2)]" />
                      <span>
                        {isDaily
                          ? `Daily limit · resets ${formatClockTime(cd.until)}`
                          : `Cooling ${coolingRemainingSec} s`}
                      </span>
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--volt)]/15 border border-[var(--volt)]/40 text-[var(--volt)] inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--volt)]" />
                      <span>Ready</span>
                    </span>
                  )}

                  {/* Shared project warning badge */}
                  {slot.sharedProjectSuspected && (
                    <span
                      title="Keys from the same Google Cloud project share quota. Create each key in a separate project at AI Studio."
                      className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--volt)]/20 text-[var(--volt)] border border-[var(--volt)]/50 cursor-help"
                    >
                      Shared project?
                    </span>
                  )}

                  {/* Simulated pending badge */}
                  {simulatedFailures[slotId] && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-[var(--ink-3)] text-[var(--volt)]">
                      Sim: 429 next
                    </span>
                  )}
                </div>

                {/* Right: on/off toggle */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEnabled(slotId, !slot.enabled)}
                    title={slot.enabled ? 'Disable key' : 'Enable key'}
                    className="text-xs text-[var(--text-2)] hover:text-[var(--text)] inline-flex items-center gap-1 font-mono"
                  >
                    <span>{slot.enabled ? 'on' : 'off'}</span>
                    {slot.enabled ? (
                      <ToggleRight className="w-5 h-5 text-[var(--volt)]" />
                    ) : (
                      <ToggleLeft className="w-5 h-5 text-[var(--text-2)]/60" />
                    )}
                  </button>
                </div>
              </div>

              {/* Secondary info and action buttons */}
              <div className="mt-2.5 pt-2 border-t border-[var(--ink-3)]/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="text-[11px] text-[var(--text-2)] font-mono">
                  {cd ? (
                    <span className="text-[var(--text-2)]">
                      {isDaily ? 'Per-day limit' : 'Per-minute limit'} · ready at{' '}
                      {formatClockTime(cd.until)}
                    </span>
                  ) : (
                    <span>
                      Today: {slot.stats?.callsToday || 0} calls · last used{' '}
                      {formatTimeAgo(slot.stats?.lastUsedAt)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 self-end sm:self-auto">
                  <button
                    type="button"
                    onClick={() => handleTestSlot(slotId)}
                    disabled={isTesting}
                    className="px-2.5 py-1 rounded-[6px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-xs text-[var(--text)] hover:text-[var(--volt)] hover:border-[var(--volt)]/50 transition-colors disabled:opacity-40 min-h-[30px] inline-flex items-center gap-1"
                  >
                    {isTesting ? (
                      <Loader2 className="w-3 h-3 animate-spin text-[var(--volt)]" />
                    ) : null}
                    <span>Test</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenAddOrReplace(slotId, true)}
                    className="px-2.5 py-1 rounded-[6px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-xs text-[var(--text-2)] hover:text-[var(--text)] transition-colors min-h-[30px]"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => removeKey(slotId)}
                    aria-label={`Remove ${slot.label}`}
                    className="p-1 rounded-[6px] text-[var(--text-2)] hover:text-[var(--danger)] transition-colors min-h-[30px] min-w-[30px] flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Error detail if invalid */}
              {slot.invalid && slot.stats?.lastError && (
                <div className="mt-2 p-2 rounded-[6px] bg-[var(--ink-2)] text-[10px] font-mono text-[var(--danger)] leading-tight">
                  {slot.stats.lastError}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Global Actions bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={handleTestAllKeys}
          disabled={isTestingAll || slots.length === 0}
          className="px-3.5 py-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] text-xs font-semibold text-[var(--text)] hover:border-[var(--volt)]/50 transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-40 min-h-[38px]"
        >
          {isTestingAll ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--volt)]" />
          ) : (
            <Zap className="w-3.5 h-3.5 text-[var(--volt)]" />
          )}
          <span>Test all keys</span>
        </button>

        <label className="flex items-center gap-2 text-xs text-[var(--text-2)] cursor-pointer select-none">
          <span>Auto-retry when all keys are busy</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoRetryWhenBusy}
            onClick={() => setAutoRetryWhenBusy(!autoRetryWhenBusy)}
            className="text-[var(--text)] font-mono inline-flex items-center gap-1"
          >
            <span>[{autoRetryWhenBusy ? 'on' : 'off'}]</span>
            {autoRetryWhenBusy ? (
              <ToggleRight className="w-5 h-5 text-[var(--volt)]" />
            ) : (
              <ToggleLeft className="w-5 h-5 text-[var(--text-2)]/60" />
            )}
          </button>
        </label>
      </div>

      {/* Informational Callouts */}
      <div className="space-y-2 pt-2 text-[11px] text-[var(--text-2)] leading-relaxed">
        <div className="flex items-start gap-1.5">
          <span className="text-[var(--volt)] font-bold">ⓘ</span>
          <p>
            Create each key in a separate Google project (AI Studio -&gt; Create API key -&gt; &ldquo;in new project&rdquo;).
          </p>
        </div>
        <div className="flex items-start gap-1.5">
          <span className="text-[var(--volt)] font-bold">ⓘ</span>
          <p>
            Free-tier keys: Google may use submitted content to improve its products. Don&apos;t process private videos with free-tier keys.
          </p>
        </div>
      </div>

      {/* Collapsible: Last AI attempts */}
      <div className="border-t border-[var(--ink-3)] pt-3">
        <button
          type="button"
          onClick={() => setShowAttempts(!showAttempts)}
          className="w-full flex items-center justify-between text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] py-1.5"
        >
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <span>Last AI attempts ({attempts.length})</span>
          </span>
          {showAttempts ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>

        {showAttempts && (
          <div className="mt-2 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] overflow-hidden">
            {attempts.length === 0 ? (
              <div className="p-3 text-xs text-[var(--text-2)] text-center">
                No recorded attempts yet.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-56 text-[11px] font-mono">
                <table className="w-full text-left whitespace-nowrap">
                  <thead className="bg-[var(--ink-2)] border-b border-[var(--ink-3)] text-[var(--text-2)]">
                    <tr>
                      <th className="p-2">Time</th>
                      <th className="p-2">Key</th>
                      <th className="p-2">Model</th>
                      <th className="p-2">Phase</th>
                      <th className="p-2">Result</th>
                      <th className="p-2 text-right">Timing (up/wait/rx)</th>
                      <th className="p-2 text-right">Tokens</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ink-3)]/40">
                    {[...attempts].reverse().map((att) => (
                      <tr key={att.id} className="hover:bg-[var(--ink-2)]/50">
                        <td className="p-2 text-[var(--text-2)]">
                          {formatClockTime(att.time)}
                        </td>
                        <td className="p-2 text-[var(--text)] font-semibold">
                          {att.keyLabel}
                          {att.simulated && (
                            <span className="ml-1 text-[9px] text-[var(--volt)]">
                              (sim)
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-[var(--text-2)] truncate max-w-[130px]">
                          {att.model}
                        </td>
                        <td className="p-2 text-[var(--text-2)]">
                          <span className="px-1.5 py-0.5 rounded bg-[var(--ink-3)] text-[10px]">
                            {att.phase || 'http'}
                          </span>
                        </td>
                        <td className="p-2">
                          <span
                            className={
                              att.result === 'ok'
                                ? 'text-[var(--volt)]'
                                : 'text-[var(--danger)]'
                            }
                          >
                            {att.result}
                          </span>
                        </td>
                        <td className="p-2 text-right text-[var(--text-2)] tabular-nums">
                          {att.uploadMs !== undefined
                            ? `${att.uploadMs}/${att.waitMs}/${att.receiveMs} ms`
                            : `${att.durationMs} ms`}
                        </td>
                        <td className="p-2 text-right text-[var(--text-2)] tabular-nums">
                          {att.tokens !== undefined
                            ? `${att.tokens} ${att.tokensThought ? `(${att.tokensThought} th)` : ''}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapsible: Developer simulate */}
      <div className="border-t border-[var(--ink-3)] pt-3">
        <button
          type="button"
          onClick={() => setShowSimulate(!showSimulate)}
          className="w-full flex items-center justify-between text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] py-1.5"
        >
          <span className="flex items-center gap-1.5">
            <FlaskConical className="w-3.5 h-3.5 text-[var(--volt)]" />
            <span>Developer: simulate</span>
          </span>
          {showSimulate ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>

        {showSimulate && (
          <div className="mt-2 p-3 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] space-y-3">
            <p className="text-[11px] text-[var(--text-2)]">
              Simulation only — no real API call is faked. Injects a synthetic failure into the scheduler for the next real attempt of that key to test rotation without burning quota.
            </p>

            <div className="space-y-2">
              {slots.map((s) => (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2 rounded-[6px] bg-[var(--ink-2)] border border-[var(--ink-3)]/60 text-xs">
                  <span className="font-semibold text-[var(--text)]">
                    {s.label} (••••{s.last4})
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setSimulatedFailure(s.id, { kind: 'minute', cooldownMs: 30000 });
                        showToast(`Simulated 429 (30s) queued for ${s.label}`);
                      }}
                      className="px-2 py-1 rounded bg-[var(--ink)] border border-[var(--ink-3)] text-[10px] font-mono text-[var(--text)] hover:border-[var(--volt)]"
                    >
                      429 per-minute (30 s)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const mid = nextMidnightPacific(Date.now());
                        const cd = Math.max(1000, mid - Date.now());
                        setSimulatedFailure(s.id, { kind: 'daily', cooldownMs: cd });
                        showToast(`Simulated 429 (daily) queued for ${s.label}`);
                      }}
                      className="px-2 py-1 rounded bg-[var(--ink)] border border-[var(--ink-3)] text-[10px] font-mono text-[var(--text)] hover:border-[var(--volt)]"
                    >
                      ...daily limit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
