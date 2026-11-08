import { create } from 'zustand';
import {
  KeySlot,
  SlotId,
  initKeyVault,
  listSlots,
  addKey as vaultAddKey,
  replaceKey as vaultReplaceKey,
  removeKey as vaultRemoveKey,
  setEnabled as vaultSetEnabled,
  setSlotInvalid as vaultSetSlotInvalid,
  setSlotTested as vaultSetSlotTested,
  setSharedProjectSuspected as vaultSetSharedProjectSuspected,
  recordKeyCall as vaultRecordKeyCall,
  recordKeySuccess as vaultRecordKeySuccess,
  recordKeyFailure as vaultRecordKeyFailure,
  isVaultInsecure,
} from '../ai/keyvault';
import {
  CooldownEntry,
  CooldownReason,
  loadStoredCooldowns,
  saveStoredCooldowns,
  makeCooldownKey,
  normalizeModelName,
  recordQuotaFailureAndCheckSharedProject,
} from '../ai/key-scheduler';

export interface AttemptLog {
  id: string;
  time: number;
  keyLabel: string;
  model: string;
  phase: 'ping' | 'upload' | 'first-byte' | 'stream' | 'http';
  result: string;
  durationMs: number;
  uploadedBytes?: number;
  uploadMs?: number;
  waitMs?: number;
  receiveMs?: number;
  tokens?: number;
  tokensIn?: number;
  tokensThought?: number;
  tokensOut?: number;
  temperature?: number;
  thinkingConfig?: string;
  simulated?: boolean;
}

export interface KeySwitchInfo {
  fromLabel: string;
  toLabel: string;
  reason: string;
  ms: number;
  at: number;
}

export interface SimulatedFailure {
  kind: 'minute' | 'daily';
  cooldownMs: number;
}

export interface KeyStoreState {
  isInitialized: boolean;
  isInsecure: boolean;
  slots: KeySlot[];
  cooldowns: Record<string, CooldownEntry>;
  lastSwitch: KeySwitchInfo | null;
  attempts: AttemptLog[];
  autoRetryWhenBusy: boolean;
  simulatedFailures: Partial<Record<SlotId, SimulatedFailure>>;

  // Actions
  init: () => Promise<void>;
  refresh: () => void;
  addKey: (slotId: SlotId, label: string, rawKey: string) => Promise<KeySlot>;
  replaceKey: (slotId: SlotId, rawKey: string) => Promise<KeySlot>;
  removeKey: (slotId: SlotId) => Promise<void>;
  setEnabled: (slotId: SlotId, enabled: boolean) => void;
  setSlotInvalid: (slotId: SlotId, invalid: boolean, error?: string) => void;
  setSlotTested: (slotId: SlotId, valid: boolean, modelCount?: number, error?: string) => void;
  applyCooldown: (
    slotId: SlotId,
    model: string,
    cooldownMs: number,
    reason: CooldownReason
  ) => void;
  recordSwitch: (info: KeySwitchInfo) => void;
  recordAttempt: (log: Omit<AttemptLog, 'id'>) => void;
  setAutoRetryWhenBusy: (enabled: boolean) => void;
  setSimulatedFailure: (slotId: SlotId, failure: SimulatedFailure | null) => void;
  consumeSimulatedFailure: (slotId: SlotId) => SimulatedFailure | null;
  checkSharedProjectFailure: (slotId: SlotId, model: string) => void;
}

const ATTEMPTS_STORAGE_KEY = 'sfx_ai_key_attempts_v1';
const AUTO_RETRY_STORAGE_KEY = 'sfx_ai_auto_retry_busy_v1';

function loadStoredAttempts(): AttemptLog[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ATTEMPTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStoredAttempts(attempts: AttemptLog[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ATTEMPTS_STORAGE_KEY, JSON.stringify(attempts.slice(-20)));
  } catch {}
}

function loadAutoRetrySetting(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = localStorage.getItem(AUTO_RETRY_STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export const useKeyStore = create<KeyStoreState>((set, get) => ({
  isInitialized: false,
  isInsecure: false,
  slots: [],
  cooldowns: {},
  lastSwitch: null,
  attempts: loadStoredAttempts(),
  autoRetryWhenBusy: loadAutoRetrySetting(),
  simulatedFailures: {},

  init: async () => {
    const { isInsecure, slots } = await initKeyVault();
    const map = loadStoredCooldowns();
    const cooldowns: Record<string, CooldownEntry> = {};
    for (const [k, v] of map.entries()) {
      cooldowns[k] = v;
    }

    set({
      isInitialized: true,
      isInsecure,
      slots,
      cooldowns,
      attempts: loadStoredAttempts(),
      autoRetryWhenBusy: loadAutoRetrySetting(),
    });
  },

  refresh: () => {
    const slots = listSlots();
    const map = loadStoredCooldowns();
    const cooldowns: Record<string, CooldownEntry> = {};
    for (const [k, v] of map.entries()) {
      cooldowns[k] = v;
    }
    set({ slots, cooldowns, isInsecure: isVaultInsecure() });
  },

  addKey: async (slotId, label, rawKey) => {
    const newSlot = await vaultAddKey(slotId, label, rawKey);
    get().refresh();
    return newSlot;
  },

  replaceKey: async (slotId, rawKey) => {
    const updated = await vaultReplaceKey(slotId, rawKey);
    get().refresh();
    return updated;
  },

  removeKey: async (slotId) => {
    await vaultRemoveKey(slotId);
    // Also remove any cooldowns for this slot
    const currentCds = { ...get().cooldowns };
    let changed = false;
    for (const key of Object.keys(currentCds)) {
      if (key.startsWith(`${slotId}|`)) {
        delete currentCds[key];
        changed = true;
      }
    }
    if (changed) {
      const map = new Map<string, CooldownEntry>();
      for (const [k, v] of Object.entries(currentCds)) {
        map.set(k, v);
      }
      saveStoredCooldowns(map);
      set({ cooldowns: currentCds });
    }
    get().refresh();
  },

  setEnabled: (slotId, enabled) => {
    vaultSetEnabled(slotId, enabled);
    get().refresh();
  },

  setSlotInvalid: (slotId, invalid, error) => {
    vaultSetSlotInvalid(slotId, invalid, error);
    get().refresh();
  },

  setSlotTested: (slotId, valid, modelCount, error) => {
    vaultSetSlotTested(slotId, valid, modelCount, error);
    get().refresh();
  },

  applyCooldown: (slotId, model, cooldownMs, reason) => {
    const key = makeCooldownKey(slotId, model);
    const until = Date.now() + cooldownMs;
    const entry: CooldownEntry = { until, reason };

    const updatedCds = { ...get().cooldowns, [key]: entry };
    const map = new Map<string, CooldownEntry>();
    for (const [k, v] of Object.entries(updatedCds)) {
      map.set(k, v);
    }
    saveStoredCooldowns(map);
    set({ cooldowns: updatedCds });
  },

  recordSwitch: (info) => {
    set({ lastSwitch: info });
  },

  recordAttempt: (log) => {
    const item: AttemptLog = {
      ...log,
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    };
    const nextAttempts = [...get().attempts, item].slice(-20);
    saveStoredAttempts(nextAttempts);
    set({ attempts: nextAttempts });
  },

  setAutoRetryWhenBusy: (enabled) => {
    try {
      localStorage.setItem(AUTO_RETRY_STORAGE_KEY, String(enabled));
    } catch {}
    set({ autoRetryWhenBusy: enabled });
  },

  setSimulatedFailure: (slotId, failure) => {
    const current = { ...get().simulatedFailures };
    if (failure) {
      current[slotId] = failure;
    } else {
      delete current[slotId];
    }
    set({ simulatedFailures: current });
  },

  consumeSimulatedFailure: (slotId) => {
    const current = { ...get().simulatedFailures };
    const failure = current[slotId] || null;
    if (failure) {
      delete current[slotId];
      set({ simulatedFailures: current });
    }
    return failure;
  },

  checkSharedProjectFailure: (slotId, model) => {
    const res = recordQuotaFailureAndCheckSharedProject(slotId, model);
    if (res.shared && res.otherSlotId) {
      vaultSetSharedProjectSuspected(slotId, true);
      vaultSetSharedProjectSuspected(res.otherSlotId, true);
      get().refresh();
    }
  },
}));
