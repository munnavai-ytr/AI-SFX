/**
 * Client-only secure key storage for multi-key BYOK rotation.
 * - AES-GCM 256 encryption using WebCrypto with a non-extractable key stored in IndexedDB.
 * - Decrypts all keys once at startup into an in-memory Map for zero-latency synchronous retrieval.
 * - API keys are NEVER exposed in listSlots, logs, or UI after saving.
 */

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export type SlotId = 'k1' | 'k2' | 'k3';

export interface KeySlot {
  id: SlotId;
  label: string;
  last4: string;
  enabled: boolean;
  invalid: boolean;
  addedAt: number;
  tested?: boolean;
  modelCount?: number;
  sharedProjectSuspected?: boolean;
  stats: {
    dayKey: string;
    callsToday: number;
    lastUsedAt: number | null;
    lastOkAt: number | null;
    lastError: string | null;
  };
}

const METADATA_STORAGE_KEY = 'sfx_ai_key_slots_v1';
const MASTER_KEY_IDB_KEY = 'sfx_ai_vault_master_key_v1';
const LEGACY_SINGLE_KEY = 'sfx_ai_gemini_api_key';
const LEGACY_TEST_STATE = 'sfx_ai_gemini_key_test_state';

// In-memory key cache for synchronous retrieval (never exposed to UI)
const inMemoryKeyCache = new Map<SlotId, string>();

let isInsecureContext = false;
let masterCryptoKey: CryptoKey | null = null;
let isInitialized = false;

export function getTodayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isVaultInsecure(): boolean {
  return isInsecureContext;
}

export function getAllCachedKeys(): string[] {
  return Array.from(inMemoryKeyCache.values()).filter((k) => k && k.length > 5);
}

/**
 * Validates a candidate raw API key.
 * - Trimmed
 * - No spaces or newlines
 * - Length >= 30
 * - Does not insist on a prefix (like AIza)
 * - Rejects duplicates against existing keys in the vault
 */
export function validateRawKey(
  rawKey: string,
  targetSlotId?: SlotId
): { valid: boolean; error?: string; cleanKey: string } {
  if (!rawKey) {
    return { valid: false, error: 'API key is required', cleanKey: '' };
  }

  const clean = rawKey.trim();

  if (/\s/.test(clean)) {
    return {
      valid: false,
      error: 'API key must not contain spaces, tabs, or newlines',
      cleanKey: clean,
    };
  }

  if (clean.length < 30) {
    return {
      valid: false,
      error: 'API key format invalid (must be at least 30 characters)',
      cleanKey: clean,
    };
  }

  // Check for duplicates
  for (const [slotId, cached] of inMemoryKeyCache.entries()) {
    if (slotId !== targetSlotId && cached === clean) {
      return {
        valid: false,
        error: `This API key is already added in slot ${slotId.toUpperCase()}`,
        cleanKey: clean,
      };
    }
  }

  return { valid: true, cleanKey: clean };
}

/**
 * Returns WebCrypto subtle interface if available.
 */
function getSubtleCrypto(): SubtleCrypto | null {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  return null;
}

/**
 * Retrieves or generates the non-extractable AES-GCM master key in IndexedDB.
 */
async function getOrCreateMasterCryptoKey(): Promise<CryptoKey | null> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    isInsecureContext = true;
    return null;
  }

  if (masterCryptoKey) {
    return masterCryptoKey;
  }

  try {
    const existing = await idbGet<CryptoKey>(MASTER_KEY_IDB_KEY);
    if (existing && existing instanceof CryptoKey) {
      masterCryptoKey = existing;
      return masterCryptoKey;
    }
  } catch (err) {
    console.warn('[KeyVault] IndexedDB master key retrieval warning:', (err as Error).message);
  }

  try {
    const newKey = await subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256,
      },
      false, // non-extractable!
      ['encrypt', 'decrypt']
    );

    try {
      await idbSet(MASTER_KEY_IDB_KEY, newKey);
    } catch (saveErr) {
      console.warn('[KeyVault] Could not persist master key to IndexedDB:', (saveErr as Error).message);
    }

    masterCryptoKey = newKey;
    return masterCryptoKey;
  } catch (genErr) {
    console.warn('[KeyVault] WebCrypto key generation failed; falling back to unencrypted storage:', (genErr as Error).message);
    isInsecureContext = true;
    return null;
  }
}

/**
 * Encrypts a raw key string into IV + ciphertext.
 */
async function encryptKey(rawKey: string): Promise<{ iv: number[]; cipher: number[] } | string> {
  const subtle = getSubtleCrypto();
  const key = await getOrCreateMasterCryptoKey();

  if (!subtle || !key) {
    isInsecureContext = true;
    return rawKey; // Plaintext fallback
  }

  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const encoder = new TextEncoder();
  const plainBytes = encoder.encode(rawKey);

  const cipherBuffer = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    plainBytes
  );

  return {
    iv: Array.from(iv),
    cipher: Array.from(new Uint8Array(cipherBuffer)),
  };
}

/**
 * Decrypts IV + ciphertext into a raw key string.
 */
async function decryptKey(payload: { iv: number[]; cipher: number[] } | string): Promise<string | null> {
  if (typeof payload === 'string') {
    return payload; // Plaintext fallback
  }

  const subtle = getSubtleCrypto();
  const key = await getOrCreateMasterCryptoKey();

  if (!subtle || !key) {
    return null;
  }

  try {
    const iv = new Uint8Array(payload.iv);
    const cipher = new Uint8Array(payload.cipher);

    const decryptedBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      key,
      cipher
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    console.warn('[KeyVault] Key decryption failed:', (err as Error).message);
    return null;
  }
}

/**
 * Loads slots metadata from localStorage.
 */
export function loadStoredSlotMetadata(): KeySlot[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(METADATA_STORAGE_KEY);
    if (!raw) return [];
    const list: KeySlot[] = JSON.parse(raw);
    const today = getTodayDateKey();

    // Ensure today's date key is updated for stats
    return list.map((slot) => {
      if (slot.stats?.dayKey !== today) {
        return {
          ...slot,
          stats: {
            ...slot.stats,
            dayKey: today,
            callsToday: 0,
          },
        };
      }
      return slot;
    });
  } catch {
    return [];
  }
}

/**
 * Saves slots metadata to localStorage.
 */
export function saveSlotMetadata(slots: KeySlot[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(METADATA_STORAGE_KEY, JSON.stringify(slots));
  } catch (err) {
    console.warn('[KeyVault] Failed to save slots metadata:', (err as Error).message);
  }
}

/**
 * Synchronous internal retrieval for Gemini client rotation.
 * Returns null if slot is not found or has no key.
 */
export function getKeySync(slotId: SlotId): string | null {
  return inMemoryKeyCache.get(slotId) || null;
}

/**
 * Masks a key for UI display (only last 4 characters).
 */
export function maskKey(rawKey: string): string {
  if (!rawKey) return '';
  const last4 = rawKey.slice(-4);
  return `••••••••${last4}`;
}

/**
 * Lists all configured slots without ever exposing the raw secret.
 */
export function listSlots(): KeySlot[] {
  return loadStoredSlotMetadata();
}

/**
 * Initializes KeyVault:
 * - Checks encryption support
 * - Migrates legacy single key if present
 * - Decrypts all keys into memory once
 */
export async function initKeyVault(): Promise<{
  isInsecure: boolean;
  slots: KeySlot[];
}> {
  if (typeof window === 'undefined') {
    return { isInsecure: false, slots: [] };
  }

  const subtle = getSubtleCrypto();
  if (!subtle) {
    isInsecureContext = true;
  }

  let slots = loadStoredSlotMetadata();

  // Legacy single-key migration
  const legacyKey = localStorage.getItem(LEGACY_SINGLE_KEY);
  if (legacyKey && legacyKey.trim().length >= 30) {
    const cleanLegacy = legacyKey.trim();
    const existingK1 = slots.find((s) => s.id === 'k1');
    if (!existingK1) {
      const today = getTodayDateKey();
      let legacyTested = false;
      let legacyModelCount = 0;
      try {
        const testRaw = localStorage.getItem(LEGACY_TEST_STATE);
        if (testRaw) {
          const parsed = JSON.parse(testRaw);
          legacyTested = Boolean(parsed.tested && parsed.valid);
          legacyModelCount = parsed.modelCount || 0;
        }
      } catch {}

      const k1Slot: KeySlot = {
        id: 'k1',
        label: 'Key 1',
        last4: cleanLegacy.slice(-4),
        enabled: true,
        invalid: false,
        addedAt: Date.now(),
        tested: legacyTested,
        modelCount: legacyModelCount,
        stats: {
          dayKey: today,
          callsToday: 0,
          lastUsedAt: null,
          lastOkAt: legacyTested ? Date.now() : null,
          lastError: null,
        },
      };

      slots.push(k1Slot);
      saveSlotMetadata(slots);

      const enc = await encryptKey(cleanLegacy);
      try {
        await idbSet(`sfx_ai_enc_key_k1`, enc);
      } catch {
        localStorage.setItem(`sfx_ai_plain_key_k1`, cleanLegacy);
      }
      inMemoryKeyCache.set('k1', cleanLegacy);
    }

    // Clean up legacy keys
    localStorage.removeItem(LEGACY_SINGLE_KEY);
    localStorage.removeItem(LEGACY_TEST_STATE);
  }

  // Load and decrypt all stored keys into inMemoryKeyCache
  for (const slot of slots) {
    try {
      let raw: string | null = null;
      try {
        const encData = await idbGet<{ iv: number[]; cipher: number[] } | string>(`sfx_ai_enc_key_${slot.id}`);
        if (encData) {
          raw = await decryptKey(encData);
        }
      } catch {}

      if (!raw) {
        // Check localStorage fallback
        const plain = localStorage.getItem(`sfx_ai_plain_key_${slot.id}`);
        if (plain) {
          raw = plain;
        }
      }

      if (raw) {
        inMemoryKeyCache.set(slot.id, raw);
      }
    } catch (err) {
      console.warn(`[KeyVault] Failed to load key for ${slot.id}:`, (err as Error).message);
    }
  }

  isInitialized = true;
  return {
    isInsecure: isInsecureContext,
    slots,
  };
}

/**
 * Adds a new key into a specific slot.
 */
export async function addKey(slotId: SlotId, label: string, rawKey: string): Promise<KeySlot> {
  const val = validateRawKey(rawKey, slotId);
  if (!val.valid) {
    throw new Error(val.error);
  }

  const clean = val.cleanKey;
  const today = getTodayDateKey();
  const last4 = clean.slice(-4);

  const newSlot: KeySlot = {
    id: slotId,
    label: label.trim() || `Key ${slotId.replace('k', '')}`,
    last4,
    enabled: true,
    invalid: false,
    addedAt: Date.now(),
    tested: false,
    stats: {
      dayKey: today,
      callsToday: 0,
      lastUsedAt: null,
      lastOkAt: null,
      lastError: null,
    },
  };

  // Encrypt and store key
  const enc = await encryptKey(clean);
  try {
    await idbSet(`sfx_ai_enc_key_${slotId}`, enc);
  } catch {
    localStorage.setItem(`sfx_ai_plain_key_${slotId}`, clean);
  }

  // Update in-memory cache
  inMemoryKeyCache.set(slotId, clean);

  // Update metadata
  const current = loadStoredSlotMetadata().filter((s) => s.id !== slotId);
  current.push(newSlot);
  current.sort((a, b) => a.id.localeCompare(b.id));
  saveSlotMetadata(current);

  return newSlot;
}

/**
 * Replaces an existing slot's key.
 */
export async function replaceKey(slotId: SlotId, rawKey: string): Promise<KeySlot> {
  const current = loadStoredSlotMetadata();
  const existing = current.find((s) => s.id === slotId);
  if (!existing) {
    throw new Error(`Slot ${slotId.toUpperCase()} does not exist`);
  }

  const val = validateRawKey(rawKey, slotId);
  if (!val.valid) {
    throw new Error(val.error);
  }

  const clean = val.cleanKey;
  const last4 = clean.slice(-4);

  const updated: KeySlot = {
    ...existing,
    last4,
    invalid: false,
    tested: false,
    sharedProjectSuspected: false,
  };

  const enc = await encryptKey(clean);
  try {
    await idbSet(`sfx_ai_enc_key_${slotId}`, enc);
  } catch {
    localStorage.setItem(`sfx_ai_plain_key_${slotId}`, clean);
  }

  inMemoryKeyCache.set(slotId, clean);

  const updatedList = current.map((s) => (s.id === slotId ? updated : s));
  saveSlotMetadata(updatedList);

  return updated;
}

/**
 * Removes a slot and wipes all associated keys from storage and memory.
 */
export async function removeKey(slotId: SlotId): Promise<void> {
  inMemoryKeyCache.delete(slotId);

  try {
    await idbDel(`sfx_ai_enc_key_${slotId}`);
  } catch {}

  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(`sfx_ai_plain_key_${slotId}`);
  }

  const current = loadStoredSlotMetadata().filter((s) => s.id !== slotId);
  saveSlotMetadata(current);
}

/**
 * Enables or disables a slot.
 */
export function setEnabled(slotId: SlotId, enabled: boolean): KeySlot | null {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return null;

  slot.enabled = enabled;
  saveSlotMetadata(current);
  return slot;
}

/**
 * Marks a slot invalid (e.g. 400 API_KEY_INVALID, 401, 403 PERMISSION_DENIED).
 */
export function setSlotInvalid(slotId: SlotId, invalid: boolean, error?: string): KeySlot | null {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return null;

  slot.invalid = invalid;
  if (error) {
    slot.stats.lastError = error;
  }
  saveSlotMetadata(current);
  return slot;
}

/**
 * Sets tested status after a manual or automatic test.
 */
export function setSlotTested(
  slotId: SlotId,
  valid: boolean,
  modelCount?: number,
  error?: string
): KeySlot | null {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return null;

  slot.tested = valid;
  slot.invalid = !valid;
  if (modelCount !== undefined) {
    slot.modelCount = modelCount;
  }
  if (valid) {
    slot.stats.lastOkAt = Date.now();
    slot.stats.lastError = null;
  } else if (error) {
    slot.stats.lastError = error;
  }
  saveSlotMetadata(current);
  return slot;
}

/**
 * Flags or clears shared project suspicion for a slot.
 */
export function setSharedProjectSuspected(slotId: SlotId, suspected: boolean): KeySlot | null {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return null;

  slot.sharedProjectSuspected = suspected;
  saveSlotMetadata(current);
  return slot;
}

/**
 * Increments callsToday count for a key when a real generateContent call starts.
 */
export function recordKeyCall(slotId: SlotId): void {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return;

  const today = getTodayDateKey();
  if (slot.stats.dayKey !== today) {
    slot.stats.dayKey = today;
    slot.stats.callsToday = 1;
  } else {
    slot.stats.callsToday = (slot.stats.callsToday || 0) + 1;
  }
  slot.stats.lastUsedAt = Date.now();
  saveSlotMetadata(current);
}

/**
 * Records a successful API response on a slot.
 */
export function recordKeySuccess(slotId: SlotId): void {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return;

  slot.stats.lastOkAt = Date.now();
  slot.stats.lastError = null;
  saveSlotMetadata(current);
}

/**
 * Records an error on a slot.
 */
export function recordKeyFailure(slotId: SlotId, error: string): void {
  const current = loadStoredSlotMetadata();
  const slot = current.find((s) => s.id === slotId);
  if (!slot) return;

  slot.stats.lastError = error;
  saveSlotMetadata(current);
}
