import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pickKey,
  classifyFailure,
  nextMidnightPacific,
  planAttempts,
  makeCooldownKey,
} from '../ai/key-scheduler';
import { KeySlot } from '../ai/keyvault';

describe('ai/key-scheduler.ts', () => {
  const baseSlot = (id: 'k1' | 'k2' | 'k3', label: string, lastUsedAt: number | null = null): KeySlot => ({
    id,
    label,
    last4: '1234',
    enabled: true,
    invalid: false,
    addedAt: 1000,
    stats: {
      dayKey: '2026-11-07',
      callsToday: 0,
      lastUsedAt,
      lastOkAt: null,
      lastError: null,
    },
  });

  describe('pickKey', () => {
    it('picks the least recently used key (null lastUsedAt comes first)', () => {
      const slots: KeySlot[] = [
        baseSlot('k1', 'Key 1', 5000),
        baseSlot('k2', 'Key 2', null),
        baseSlot('k3', 'Key 3', 3000),
      ];
      const cooldowns = new Map<string, { until: number }>();
      const picked = pickKey(slots, 'gemini-3.8-flash', cooldowns, 6000);
      expect(picked?.id).toBe('k2');
    });

    it('picks least recently used among keys with timestamps', () => {
      const slots: KeySlot[] = [
        baseSlot('k1', 'Key 1', 5000),
        baseSlot('k2', 'Key 2', 2000),
        baseSlot('k3', 'Key 3', 4000),
      ];
      const cooldowns = new Map<string, { until: number }>();
      const picked = pickKey(slots, 'gemini-3.8-flash', cooldowns, 6000);
      expect(picked?.id).toBe('k2');
    });

    it('skips disabled and invalid keys', () => {
      const s1 = baseSlot('k1', 'Key 1', null);
      s1.enabled = false;
      const s2 = baseSlot('k2', 'Key 2', null);
      s2.invalid = true;
      const s3 = baseSlot('k3', 'Key 3', 1000);

      const slots = [s1, s2, s3];
      const cooldowns = new Map<string, { until: number }>();
      const picked = pickKey(slots, 'gemini-3.8-flash', cooldowns, 2000);
      expect(picked?.id).toBe('k3');
    });

    it('respects per-model cooldown', () => {
      const s1 = baseSlot('k1', 'Key 1', 1000);
      const s2 = baseSlot('k2', 'Key 2', 2000);
      const slots = [s1, s2];

      const cooldowns = new Map<string, { until: number }>();
      // Cooldown active for k1 on gemini-3.8-flash
      cooldowns.set(makeCooldownKey('k1', 'models/gemini-3.8-flash'), { until: 10000 });

      // For gemini-3.8-flash: k1 is cooling, picks k2
      const picked38 = pickKey(slots, 'models/gemini-3.8-flash', cooldowns, 5000);
      expect(picked38?.id).toBe('k2');

      // For gemini-2.5-flash: k1 is NOT cooling, so k1 (LRU 1000 < 2000) is picked!
      const picked25 = pickKey(slots, 'models/gemini-2.5-flash', cooldowns, 5000);
      expect(picked25?.id).toBe('k1');
    });
  });

  describe('classifyFailure', () => {
    it('classifies 429 with RetryInfo "38s" + PerMinute quota as minute limit with cooldown 39s', () => {
      const body = {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '38s',
            },
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaId: 'GenerateContentRequestsPerMinute',
                  quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests_per_minute',
                },
              ],
            },
          ],
        },
      };

      const res = classifyFailure(429, body, 'http');
      expect(res.kind).toBe('minute');
      if (res.kind === 'minute') {
        expect(res.cooldownMs).toBe(39000); // 38s + 1s = 39s
      }
    });

    it('classifies 429 with PerDay in QuotaFailure as daily limit', () => {
      const now = Date.now();
      const body = {
        error: {
          code: 429,
          message: 'Quota exceeded for GenerateContent requests per day',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaId: 'GenerateContentRequestsPerDay',
                  quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests_per_day',
                },
              ],
            },
          ],
        },
      };

      const res = classifyFailure(429, body, 'http', now);
      expect(res.kind).toBe('daily');
      if (res.kind === 'daily') {
        expect(res.cooldownMs).toBeGreaterThan(0);
        expect(res.cooldownMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      }
    });

    it('classifies 429 without details as minute limit with default 60s cooldown', () => {
      const res = classifyFailure(429, { error: { message: 'Quota exceeded' } }, 'http');
      expect(res.kind).toBe('minute');
      if (res.kind === 'minute') {
        expect(res.cooldownMs).toBe(60000);
      }
    });

    it('classifies 400 API_KEY_INVALID / API key not valid as invalid', () => {
      const body1 = {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
            },
          ],
        },
      };
      const res1 = classifyFailure(400, body1, 'http');
      expect(res1.kind).toBe('invalid');

      const res2 = classifyFailure(400, { error: { message: 'API key not valid' } }, 'http');
      expect(res2.kind).toBe('invalid');
    });

    it('classifies 403 PERMISSION_DENIED as invalid', () => {
      const body = {
        error: {
          code: 403,
          message: 'Permission denied on resource',
          status: 'PERMISSION_DENIED',
        },
      };
      const res = classifyFailure(403, body, 'http');
      expect(res.kind).toBe('invalid');
    });

    it('classifies other 400 as client-error', () => {
      const body = {
        error: {
          code: 400,
          message: 'Invalid JSON schema in generationConfig',
          status: 'INVALID_ARGUMENT',
        },
      };
      const res = classifyFailure(400, body, 'http');
      expect(res.kind).toBe('client-error');
    });

    it('classifies 503 / 5xx as server error with 30s cooldown', () => {
      const res503 = classifyFailure(503, { error: { message: 'Unavailable' } }, 'http');
      expect(res503.kind).toBe('server');
      if (res503.kind === 'server') {
        expect(res503.cooldownMs).toBe(30000);
      }

      const res500 = classifyFailure(500, null, 'http');
      expect(res500.kind).toBe('server');
    });

    it('classifies first-byte timeout as suspect with 10 min cooldown', () => {
      const res = classifyFailure(null, null, 'first-byte');
      expect(res.kind).toBe('suspect');
      if (res.kind === 'suspect') {
        expect(res.cooldownMs).toBe(10 * 60 * 1000);
      }
    });

    it('classifies upload stall / offline as network failure', () => {
      const resUpload = classifyFailure(null, null, 'upload');
      expect(resUpload.kind).toBe('network');

      const resOffline = classifyFailure(null, null, 'http');
      expect(resOffline.kind).toBe('network');
    });
  });

  describe('nextMidnightPacific', () => {
    it('returns a time in the future <= 24 h away', () => {
      const now = Date.now();
      const mid = nextMidnightPacific(now);
      expect(mid).toBeGreaterThan(now);
      const diffHours = (mid - now) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(0);
      expect(diffHours).toBeLessThanOrEqual(24.5);
    });
  });

  describe('planAttempts', () => {
    it('plans attempts for first 2 models across ready keys in LRU order, max 6 pairs', () => {
      const slots: KeySlot[] = [
        baseSlot('k1', 'Key 1', 1000),
        baseSlot('k2', 'Key 2', null),
        baseSlot('k3', 'Key 3', 2000),
      ];
      const cooldowns = new Map<string, { until: number }>();
      const ranked = ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-2.5-flash'];

      const plan = planAttempts(ranked, slots, cooldowns, 5000);
      expect(plan.allBusy).toBe(false);
      if (!plan.allBusy) {
        // Order for each model: k2 (null) then k1 (1000) then k3 (2000)
        expect(plan.attempts).toHaveLength(6);
        expect(plan.attempts[0]).toEqual({ slot: slots[1], model: 'models/gemini-3.8-flash' });
        expect(plan.attempts[1]).toEqual({ slot: slots[0], model: 'models/gemini-3.8-flash' });
        expect(plan.attempts[2]).toEqual({ slot: slots[2], model: 'models/gemini-3.8-flash' });
        expect(plan.attempts[3]).toEqual({ slot: slots[1], model: 'models/gemini-3.7-flash' });
        expect(plan.attempts[4]).toEqual({ slot: slots[0], model: 'models/gemini-3.7-flash' });
        expect(plan.attempts[5]).toEqual({ slot: slots[2], model: 'models/gemini-3.7-flash' });
      }
    });

    it('skips cooling keys and returns soonestReadyAt when allBusy', () => {
      const slots: KeySlot[] = [baseSlot('k1', 'Key 1', 1000)];
      const cooldowns = new Map<string, { until: number }>();
      const now = 5000;
      cooldowns.set(makeCooldownKey('k1', 'models/gemini-3.8-flash'), { until: 15000 });
      cooldowns.set(makeCooldownKey('k1', 'models/gemini-3.7-flash'), { until: 12000 });

      const plan = planAttempts(
        ['models/gemini-3.8-flash', 'models/gemini-3.7-flash'],
        slots,
        cooldowns,
        now
      );
      expect(plan.allBusy).toBe(true);
      if (plan.allBusy) {
        expect(plan.soonestReadyAt).toBe(12000);
      }
    });
  });
});
