'use client';

import React, { useState } from 'react';
import { SFX_TYPES, SfxType } from '@/ai/sfx-types';
import { getSfxSound } from '@/audio/sfx/manager';
import { playSingleSound, getSharedAudioContext } from '@/audio/preview';
import { SfxSound } from '@/audio/sfx/provider';
import { ArrowLeft, Play, Volume2, Loader2, Info } from 'lucide-react';

interface MeasuredSoundInfo {
  type: SfxType;
  variant: number;
  duration: number;
  anchor: number;
  peakDb: number;
}

export function SfxTestScreen({ onBack }: { onBack: () => void }) {
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [measuredMap, setMeasuredMap] = useState<Map<string, MeasuredSoundInfo>>(new Map());
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const typesList = Object.keys(SFX_TYPES) as SfxType[];

  const handlePlayVariant = async (type: SfxType, variant: number) => {
    const key = `${type}:${variant}`;
    setLoadingKey(key);

    try {
      // Resume AudioContext on user interaction
      getSharedAudioContext();

      const sound: SfxSound = await getSfxSound(type, variant);

      setMeasuredMap((prev) => {
        const next = new Map(prev);
        next.set(key, {
          type,
          variant,
          duration: sound.duration,
          anchor: sound.anchor,
          peakDb: sound.peakDb,
        });
        return next;
      });

      setPlayingKey(key);
      await playSingleSound(sound, 1.0, 1.0);

      setTimeout(() => {
        setPlayingKey((current) => (current === key ? null : current));
      }, Math.max(300, sound.duration * 1000));
    } catch (err) {
      console.error(`Failed to play sound ${key}:`, err);
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ink)] text-[var(--text)]">
      {/* Header */}
      <header className="border-b border-[var(--ink-3)] safe-padding-top px-4 sm:px-8 py-3.5 bg-[var(--ink)] sticky top-0 z-20">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-base font-bold tracking-tight text-[var(--text)]">
                Sound Effects Library Test
              </h1>
              <p className="text-xs text-[var(--text-2)] font-mono">
                Audition all 30 sound types × 3 deterministic variants
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 lg:p-8 safe-padding-bottom space-y-6">
        <div className="p-4 rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] text-xs text-[var(--text-2)] flex items-start gap-2.5 leading-relaxed">
          <Info className="w-4 h-4 text-[var(--volt)] shrink-0 mt-0.5" />
          <span>
            Every sound is generated dynamically via WebAudio DSP primitives or custom pack samples.
            Tap a variant button to audition the sound, measure its exact duration, key arrival anchor time, and peak dBFS.
          </span>
        </div>

        <div className="space-y-3">
          {typesList.map((type) => {
            const description = SFX_TYPES[type];

            return (
              <div
                key={type}
                className="p-4 rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-bold text-[var(--text)] font-mono flex items-center gap-2">
                      <span className="text-[var(--volt)]">◆</span>
                      <span>{type}</span>
                    </h2>
                    <p className="text-xs text-[var(--text-2)] mt-0.5">{description}</p>
                  </div>
                </div>

                {/* 3 Variant Buttons */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                  {[0, 1, 2].map((v) => {
                    const key = `${type}:${v}`;
                    const measured = measuredMap.get(key);
                    const isPlaying = playingKey === key;
                    const isLoading = loadingKey === key;

                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => handlePlayVariant(type, v)}
                        disabled={isLoading}
                        className={`p-3 rounded-[10px] border transition-all text-left flex flex-col justify-between gap-1.5 min-h-[56px] ${
                          isPlaying
                            ? 'bg-[var(--volt)] text-[var(--volt-ink)] border-[var(--volt)] glow-volt-border'
                            : 'bg-[var(--ink)] border-[var(--ink-3)] hover:border-[var(--volt)]/50 text-[var(--text)]'
                        }`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className={`font-semibold text-xs ${isPlaying ? 'text-[var(--volt-ink)]' : 'text-[var(--text)]'}`}>
                            Variant {v + 1}
                          </span>
                          {isLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin text-[var(--volt)] shrink-0" />
                          ) : isPlaying ? (
                            <Volume2 className="w-4 h-4 text-[var(--volt-ink)] animate-pulse shrink-0" />
                          ) : (
                            <Play className="w-3.5 h-3.5 text-[var(--text-2)] shrink-0" />
                          )}
                        </div>

                        {measured ? (
                          <div
                            className={`text-[10px] font-mono flex justify-between w-full ${
                              isPlaying ? 'text-[var(--volt-ink)]/90' : 'text-[var(--text-2)]'
                            }`}
                          >
                            <span>dur: {measured.duration}s</span>
                            <span>anc: {measured.anchor}s</span>
                            <span>{measured.peakDb} dB</span>
                          </div>
                        ) : (
                          <span
                            className={`text-[10px] font-mono ${
                              isPlaying ? 'text-[var(--volt-ink)]/70' : 'text-[var(--text-2)]/60'
                            }`}
                          >
                            Tap to measure &amp; play
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
