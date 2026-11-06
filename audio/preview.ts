import { MixEvent, eventGain, sfxPeakDb } from './mix';
import { SfxSound } from './sfx/provider';
import { getSfxSound, preloadSounds } from './sfx/manager';
import { SR } from './sfx/dsp';

const MASTER_VOLUME_KEY = 'sfx_master_volume';
const SYNC_OFFSET_KEY = 'sfx_sync_offset_ms';
const AUDIO_MODE_KEY = 'sfx_audio_mode';

export type AudioMode = 'with_sfx' | 'original';

// Singleton AudioContext shared across the whole application
let sharedAudioCtx: AudioContext | null = null;
let masterGainNode: GainNode | null = null;
const audioBufferCache = new Map<string, AudioBuffer>();

export function getSharedAudioContext(): AudioContext {
  if (typeof window === 'undefined') {
    throw new Error('AudioContext can only be created in the browser environment.');
  }
  if (!sharedAudioCtx) {
    const AudioCtxClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioCtx = new AudioCtxClass({ sampleRate: SR });
    masterGainNode = sharedAudioCtx.createGain();
    masterGainNode.connect(sharedAudioCtx.destination);
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function getStoredMasterVolume(): number {
  if (typeof window === 'undefined') return 1.0;
  try {
    const val = localStorage.getItem(MASTER_VOLUME_KEY);
    return val !== null ? parseFloat(val) : 1.0;
  } catch {
    return 1.0;
  }
}

export function setStoredMasterVolume(vol: number): void {
  const clamped = Math.max(0, Math.min(1.5, vol));
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(MASTER_VOLUME_KEY, String(clamped));
    } catch {}
  }
  if (masterGainNode && sharedAudioCtx) {
    masterGainNode.gain.setValueAtTime(clamped, sharedAudioCtx.currentTime);
  }
}

export function getStoredSyncOffsetMs(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const val = localStorage.getItem(SYNC_OFFSET_KEY);
    return val !== null ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

export function setStoredSyncOffsetMs(offsetMs: number): void {
  const clamped = Math.max(-300, Math.min(300, offsetMs));
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(SYNC_OFFSET_KEY, String(clamped));
    } catch {}
  }
}

export function getStoredAudioMode(): AudioMode {
  if (typeof window === 'undefined') return 'with_sfx';
  try {
    const val = localStorage.getItem(AUDIO_MODE_KEY);
    return val === 'original' ? 'original' : 'with_sfx';
  } catch {
    return 'with_sfx';
  }
}

export function setStoredAudioMode(mode: AudioMode): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(AUDIO_MODE_KEY, mode);
    } catch {}
  }
}

/**
 * Pure function to select events that should be scheduled in the upcoming lookahead window.
 */
export function selectToSchedule(
  events: MixEvent[],
  sounds: Map<string, SfxSound>,
  videoTime: number,
  lookaheadSec: number,
  alreadyScheduled: Set<string>
): MixEvent[] {
  const selected: MixEvent[] = [];

  for (const e of events) {
    if (!e.enabled) continue;
    if (alreadyScheduled.has(e.id)) continue;

    const sound = sounds.get(`${e.type}:${e.variant}`);
    if (!sound) continue;

    const startVideoTime = e.time - sound.anchor;

    // Inside lookahead window or slightly past (< 0.15s)
    if (startVideoTime >= videoTime - 0.15 && startVideoTime <= videoTime + lookaheadSec) {
      selected.push(e);
    }
  }

  return selected;
}

/**
 * Plays a single sound immediately through the shared AudioContext (for preview/audition).
 */
export async function playSingleSound(
  sound: SfxSound,
  volume = 1.0,
  masterVol = 1.0
): Promise<void> {
  const ctx = getSharedAudioContext();
  const buffer = ctx.createBuffer(1, sound.samples.length, sound.sampleRate);
  buffer.getChannelData(0).set(sound.samples);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gainNode = ctx.createGain();
  const gainVal = Math.min(1.5, Math.max(0, volume)) * masterVol;
  gainNode.gain.setValueAtTime(gainVal, ctx.currentTime);

  source.connect(gainNode);
  gainNode.connect(ctx.destination);

  source.start(0);
}

/**
 * Class managing active WebAudio preview scheduling synced with video playback.
 */
export class PreviewScheduler {
  private activeSources: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private scheduledEventIds = new Set<string>();
  private soundsMap = new Map<string, SfxSound>();
  private isRunning = false;
  private animFrameId = 0;
  private lastVideoTime = -1;

  constructor(
    private videoElement: HTMLVideoElement,
    private eventsProvider: () => MixEvent[],
    private speechSegments: { start: number; end: number }[],
    private envelopeDb: number[] | null,
    private onProgress?: (done: number, total: number) => void
  ) {}

  async prepare(events: MixEvent[]): Promise<void> {
    const activeEvents = events.filter((e) => e.enabled);
    const uniqueTypes = new Map<string, { type: any; variant: number }>();

    for (const e of activeEvents) {
      const key = `${e.type}:${e.variant}`;
      if (!uniqueTypes.has(key)) {
        uniqueTypes.set(key, { type: e.type, variant: e.variant });
      }
    }

    const items = Array.from(uniqueTypes.values());
    let done = 0;
    const total = items.length;
    this.onProgress?.(0, total);

    for (const item of items) {
      const sound = await getSfxSound(item.type, item.variant);
      this.soundsMap.set(`${item.type}:${item.variant}`, sound);
      done++;
      this.onProgress?.(done, total);
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduledEventIds.clear();
    this.lastVideoTime = this.videoElement.currentTime;

    const tick = () => {
      if (!this.isRunning) return;

      const currentVideoTime = this.videoElement.currentTime;
      // Handle seek or loop back
      if (currentVideoTime < this.lastVideoTime || currentVideoTime - this.lastVideoTime > 0.5) {
        this.stopAllSources();
        this.scheduledEventIds.clear();
      }
      this.lastVideoTime = currentVideoTime;

      if (!this.videoElement.paused && !this.videoElement.ended) {
        this.scheduleTick();
      }

      this.animFrameId = requestAnimationFrame(tick);
    };

    this.animFrameId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.isRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.stopAllSources();
    this.scheduledEventIds.clear();
  }

  private stopAllSources(): void {
    for (const item of this.activeSources) {
      try {
        item.source.stop();
        item.source.disconnect();
        item.gain.disconnect();
      } catch {}
    }
    this.activeSources = [];
  }

  private scheduleTick(): void {
    const ctx = getSharedAudioContext();
    const mode = getStoredAudioMode();

    if (mode === 'original') {
      return; // SFX muted
    }

    const events = this.eventsProvider();
    const videoTime = this.videoElement.currentTime;
    const playbackRate = this.videoElement.playbackRate || 1.0;
    const syncOffsetMs = getStoredSyncOffsetMs();
    const masterVol = getStoredMasterVolume();
    const basePeakDb = sfxPeakDb(this.envelopeDb);

    const lookaheadSec = 0.25;
    const toSchedule = selectToSchedule(
      events,
      this.soundsMap,
      videoTime,
      lookaheadSec,
      this.scheduledEventIds
    );

    for (const e of toSchedule) {
      const sound = this.soundsMap.get(`${e.type}:${e.variant}`);
      if (!sound) continue;

      this.scheduledEventIds.add(e.id);

      const startVideoTime = e.time - sound.anchor;
      const deltaSec =
        (startVideoTime - videoTime + syncOffsetMs / 1000) / playbackRate;

      // WebAudio Buffer Source
      const bufferKey = `${e.type}:${e.variant}`;
      let audioBuffer = audioBufferCache.get(bufferKey);
      if (!audioBuffer) {
        audioBuffer = ctx.createBuffer(1, sound.samples.length, sound.sampleRate);
        audioBuffer.getChannelData(0).set(sound.samples);
        audioBufferCache.set(bufferKey, audioBuffer);
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.setValueAtTime(playbackRate, ctx.currentTime);

      const gainVal = eventGain(e, this.speechSegments, basePeakDb, masterVol);
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(gainVal, ctx.currentTime);

      source.connect(gainNode);
      if (masterGainNode) {
        gainNode.connect(masterGainNode);
      } else {
        gainNode.connect(ctx.destination);
      }

      const activeObj = { source, gain: gainNode };
      this.activeSources.push(activeObj);

      source.onended = () => {
        const idx = this.activeSources.indexOf(activeObj);
        if (idx !== -1) {
          this.activeSources.splice(idx, 1);
        }
      };

      if (deltaSec >= 0) {
        source.start(ctx.currentTime + deltaSec);
      } else if (deltaSec >= -0.15) {
        source.start(0, Math.abs(deltaSec));
      }
    }
  }
}
