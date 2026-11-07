import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initKeyVault,
  addKey,
  replaceKey,
  removeKey,
  getKeySync,
  listSlots,
  validateRawKey,
} from '../ai/keyvault';
import { callGeminiGenerateContent, redactApiKey } from '../ai/gemini';
import { useKeyStore } from '../stores/use-key-store';

// Polyfill localStorage & window for headless Node test environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as any;
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = globalThis;
}

describe('ai/keyvault.ts & Rotation Loop', () => {
  const fakeKey1 = 'AIzaSyA_TEST_KEY_ONE_1234567890ABCDEFGH';
  const fakeKey2 = 'AIzaSyB_TEST_KEY_TWO_1234567890ABCDEFGH';
  const fakeKey3 = 'AIzaSyC_TEST_KEY_THR_1234567890ABCDEFGH';

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Key Validation', () => {
    it('validates key format (trimmed, no spaces, length >= 30, no prefix required)', () => {
      expect(validateRawKey('').valid).toBe(false);
      expect(validateRawKey('short_key_123').valid).toBe(false);
      expect(validateRawKey('AIzaSy key with spaces 1234567890').valid).toBe(false);
      expect(validateRawKey('AIzaSy\nkeyWithNewline1234567890123').valid).toBe(false);

      // Valid without AIza prefix
      const customPrefix = 'custom_prefix_key_1234567890abcdefghij';
      expect(validateRawKey(customPrefix).valid).toBe(true);

      // Valid standard
      expect(validateRawKey(fakeKey1).valid).toBe(true);
    });
  });

  describe('Encryption Round Trip with WebCrypto', () => {
    it('encrypts and stores key, then retrieves it synchronously via getKeySync without exposing secret in listSlots', async () => {
      await initKeyVault();

      const slot = await addKey('k1', 'Key 1', fakeKey1);
      expect(slot.id).toBe('k1');
      expect(slot.last4).toBe(fakeKey1.slice(-4));

      // listSlots must NEVER contain the raw key
      const slots = listSlots();
      expect(slots).toHaveLength(1);
      const slotJson = JSON.stringify(slots);
      expect(slotJson).not.toContain(fakeKey1);
      expect(slots[0].last4).toBe(fakeKey1.slice(-4));

      // Synchronous retrieval returns the decrypted key
      const retrieved = getKeySync('k1');
      expect(retrieved).toBe(fakeKey1);

      // Replaces key
      await replaceKey('k1', fakeKey2);
      expect(getKeySync('k1')).toBe(fakeKey2);

      // Removes key and wipes from memory
      await removeKey('k1');
      expect(getKeySync('k1')).toBeNull();
      expect(listSlots()).toHaveLength(0);
    });
  });

  describe('Legacy Single-Key Migration', () => {
    it('migrates legacy sfx_ai_gemini_api_key into Key 1 and removes legacy storage', async () => {
      localStorage.setItem('sfx_ai_gemini_api_key', fakeKey1);
      localStorage.setItem(
        'sfx_ai_gemini_key_test_state',
        JSON.stringify({ tested: true, valid: true, modelCount: 5 })
      );

      await initKeyVault();

      const slots = listSlots();
      expect(slots).toHaveLength(1);
      expect(slots[0].id).toBe('k1');
      expect(slots[0].label).toBe('Key 1');
      expect(slots[0].last4).toBe(fakeKey1.slice(-4));
      expect(slots[0].tested).toBe(true);
      expect(slots[0].modelCount).toBe(5);

      expect(getKeySync('k1')).toBe(fakeKey1);
      expect(localStorage.getItem('sfx_ai_gemini_api_key')).toBeNull();
      expect(localStorage.getItem('sfx_ai_gemini_key_test_state')).toBeNull();
    });
  });

  describe('Secret Sanitization (Keys Never Exposed)', () => {
    it('redacts all registered and unregistered keys from error strings and logs', async () => {
      await initKeyVault();
      await addKey('k1', 'Key 1', fakeKey1);
      await addKey('k2', 'Key 2', fakeKey2);

      const rawError = `Failed to connect with key ${fakeKey1} and backup ${fakeKey2} and other AIzaSyD_TEST_OTHER_1234567890ABCDEFGH`;
      const cleaned = redactApiKey(rawError);

      expect(cleaned).not.toContain(fakeKey1);
      expect(cleaned).not.toContain(fakeKey2);
      expect(cleaned).not.toContain('AIzaSyD_TEST_OTHER_1234567890ABCDEFGH');
      expect(cleaned).toContain('[REDACTED]');
    });
  });

  describe('Rotation Loop with Mocked Transport', () => {
    it('rotates from key1 (429) to key2 (success) and measures switchMs', async () => {
      await initKeyVault();
      await addKey('k1', 'Key 1', fakeKey1);
      await addKey('k2', 'Key 2', fakeKey2);
      await useKeyStore.getState().init();

      let fetchCallCount = 0;
      let usedKeyHeader: string[] = [];

      global.fetch = vi.fn().mockImplementation(async (url, init) => {
        fetchCallCount++;
        const headers = init?.headers as Record<string, string>;
        const keyUsed = headers?.['x-goog-api-key'] || '';
        usedKeyHeader.push(keyUsed);

        // Models list call
        if (url.includes('/models?')) {
          return {
            ok: true,
            json: async () => ({
              models: [
                { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
              ],
            }),
          };
        }

        // GenerateContent: First call (k1) fails with 429 RetryInfo
        if (fetchCallCount === 2) {
          return {
            ok: false,
            status: 429,
            json: async () => ({
              error: {
                code: 429,
                message: 'Quota exceeded for GenerateContent requests per minute',
                status: 'RESOURCE_EXHAUSTED',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                    retryDelay: '38s',
                  },
                ],
              },
            }),
          };
        }

        // Second call (k2) succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"events": []}' }] } }],
          }),
        };
      }) as any;

      const toastSwitches: string[] = [];
      const res = await callGeminiGenerateContent(
        {
          contents: [{ parts: [{ text: 'Test prompt' }] }],
        },
        {
          onToastSwitch: (msg) => toastSwitches.push(msg),
        }
      );

      expect(res.text).toBe('{"events": []}');
      expect(res.keyUsed).toBe('Key 2');

      // Verify rotation happened
      expect(usedKeyHeader).toContain(fakeKey1);
      expect(usedKeyHeader).toContain(fakeKey2);

      // Verify switch was recorded in key store
      const lastSwitch = useKeyStore.getState().lastSwitch;
      expect(lastSwitch).not.toBeNull();
      expect(lastSwitch?.fromLabel).toBe('Key 1');
      expect(lastSwitch?.toLabel).toBe('Key 2');
      expect(lastSwitch?.ms).toBeGreaterThanOrEqual(0);

      // Verify AttemptLog entries contain no raw secrets
      const attempts = useKeyStore.getState().attempts;
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      const attemptsJson = JSON.stringify(attempts);
      expect(attemptsJson).not.toContain(fakeKey1);
      expect(attemptsJson).not.toContain(fakeKey2);
    });

    it('does NOT rotate on network error or client-error', async () => {
      await initKeyVault();
      await addKey('k1', 'Key 1', fakeKey1);
      await addKey('k2', 'Key 2', fakeKey2);
      await useKeyStore.getState().init();

      let generateContentCalls = 0;

      global.fetch = vi.fn().mockImplementation(async (url) => {
        if (url.includes('/models?')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }],
            }),
          };
        }

        generateContentCalls++;
        // Client error 400 invalid schema
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              code: 400,
              message: 'Invalid property in request schema',
              status: 'INVALID_ARGUMENT',
            },
          }),
        };
      }) as any;

      await expect(
        callGeminiGenerateContent({
          contents: [{ parts: [{ text: 'Test prompt' }] }],
        })
      ).rejects.toThrow(/Invalid property/);

      // Must fail fast without rotating to Key 2
      expect(generateContentCalls).toBe(1);
    });

    it('throws clear message when all keys are busy and auto-retry is off', async () => {
      await initKeyVault();
      await addKey('k1', 'Key 1', fakeKey1);
      await useKeyStore.getState().init();
      useKeyStore.getState().setAutoRetryWhenBusy(false);

      // Set active cooldown for k1 on both candidate models
      useKeyStore.getState().applyCooldown('k1', 'models/gemini-3.8-flash', 45000, 'minute');
      useKeyStore.getState().applyCooldown('k1', 'models/gemini-3.7-flash', 45000, 'minute');

      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        }),
      })) as any;

      await expect(
        callGeminiGenerateContent({
          contents: [{ parts: [{ text: 'Test' }] }],
        })
      ).rejects.toThrow(/All keys are at their limit/);
    });
  });
});
