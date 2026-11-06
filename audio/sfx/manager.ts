import { SfxType } from '@/ai/sfx-types';
import { SfxSound } from './provider';
import { PackProvider } from './pack';
import { SynthProvider } from './synth';

const packProvider = new PackProvider();
const synthProvider = new SynthProvider();

const soundCache = new Map<string, SfxSound>();

export async function getSfxSound(type: SfxType, variant: number): Promise<SfxSound> {
  const v = Math.max(0, Math.min(2, variant));
  const key = `${type}:${v}`;

  if (soundCache.has(key)) {
    return soundCache.get(key)!;
  }

  // 1. Try PackProvider
  let sound = await packProvider.get(type, v);

  // 2. Fallback to SynthProvider
  if (!sound) {
    sound = (await synthProvider.get(type, v))!;
  }

  soundCache.set(key, sound);
  return sound;
}

export async function preloadSounds(
  items: { type: SfxType; variant: number }[],
  onProgress?: (count: number, total: number) => void
): Promise<void> {
  const total = items.length;
  let done = 0;

  for (const item of items) {
    await getSfxSound(item.type, item.variant);
    done++;
    onProgress?.(done, total);
    // Yield to the browser event loop between generating heavy sounds
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function clearSoundCache(): void {
  soundCache.clear();
}
