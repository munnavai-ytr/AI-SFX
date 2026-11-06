'use client';

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { AnalysisBundle } from '@/types/analysis';
import { SfxEvent } from '@/ai/sfx-types';
import { formatDuration } from '@/lib/format';

interface AnalysisViewProps {
  bundle: AnalysisBundle;
  events?: SfxEvent[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onSeek: (targetTime: number) => void;
  onSelectEvent?: (event: SfxEvent) => void;
}

export function AnalysisView({
  bundle,
  events = [],
  videoRef,
  onSeek,
  onSelectEvent,
}: AnalysisViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastDrawTimeRef = useRef<number>(0);
  const [activeEvent, setActiveEvent] = useState<SfxEvent | null>(null);

  const duration = bundle.duration || 1;

  const draw = useCallback(
    (currentTime: number, highlightedEvent: SfxEvent | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;

      // Clear background
      ctx.fillStyle = '#14171E'; // var(--ink-2)
      ctx.fillRect(0, 0, width, height);

      // Subtle horizontal center gridline
      ctx.strokeStyle = '#1D212B'; // var(--ink-3)
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // 1. Draw Quiet Gaps (shaded faint bands)
      if (bundle.quietGaps && bundle.quietGaps.length > 0) {
        ctx.fillStyle = 'rgba(154, 163, 178, 0.12)'; // faint text-2
        for (const gap of bundle.quietGaps) {
          const x1 = (gap.start / duration) * width;
          const x2 = (gap.end / duration) * width;
          ctx.fillRect(x1, 0, Math.max(2, x2 - x1), height);
        }
      }

      // 2. Draw Loudness Envelope Waveform
      if (bundle.hasAudio && bundle.envelopeDb && bundle.envelopeDb.length > 0) {
        const env = bundle.envelopeDb;
        const count = env.length;
        const centerY = height / 2;
        const maxAmpHeight = height * 0.4;

        ctx.fillStyle = 'rgba(182, 255, 59, 0.22)'; // volt with alpha
        ctx.strokeStyle = '#B6FF3B'; // volt
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        // Upper half of waveform
        for (let i = 0; i < count; i++) {
          const x = (i / count) * width;
          // Normalize dBFS (-90dB to 0dB -> 0 to 1)
          const db = Math.max(-90, Math.min(0, env[i]));
          const amp = (db + 90) / 90;
          const y = centerY - amp * maxAmpHeight;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        // Lower half of waveform (mirror)
        for (let i = count - 1; i >= 0; i--) {
          const x = (i / count) * width;
          const db = Math.max(-90, Math.min(0, env[i]));
          const amp = (db + 90) / 90;
          const y = centerY + amp * maxAmpHeight;
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (!bundle.hasAudio) {
        // No audio track message
        ctx.fillStyle = '#9AA3B2';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No audio track in video', width / 2, height / 2);
      }

      // 3. Draw Scene Cut Markers (thin white vertical lines)
      if (bundle.cuts && bundle.cuts.length > 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1;
        for (const cut of bundle.cuts) {
          const x = (cut.t / duration) * width;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();

          // Small cut tick at top
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(x - 1, 0, 2, 4);
        }
      }

      // 4. Draw Transient Markers as small grey ticks (visually distinct from volt SFX diamonds)
      if (bundle.transients && bundle.transients.length > 0) {
        ctx.strokeStyle = 'rgba(154, 163, 178, 0.75)'; // text-2 grey
        ctx.lineWidth = 1.2;
        for (const tr of bundle.transients) {
          const x = (tr.t / duration) * width;
          ctx.beginPath();
          ctx.moveTo(x, height - 8);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }

      // 5. Draw Selected SFX Events as Volt Diamonds (◆)
      if (events && events.length > 0) {
        const diamondY = 16;
        const dSize = 5;

        for (const ev of events) {
          const x = (ev.time / duration) * width;
          const isHighlighted = highlightedEvent?.id === ev.id;

          // Diamond path
          ctx.beginPath();
          ctx.moveTo(x, diamondY - (isHighlighted ? dSize + 2 : dSize));
          ctx.lineTo(x + (isHighlighted ? dSize + 2 : dSize), diamondY);
          ctx.lineTo(x, diamondY + (isHighlighted ? dSize + 2 : dSize));
          ctx.lineTo(x - (isHighlighted ? dSize + 2 : dSize), diamondY);
          ctx.closePath();

          ctx.fillStyle = '#B6FF3B'; // volt
          ctx.fill();

          ctx.strokeStyle = '#0B0D12'; // ink
          ctx.lineWidth = 1;
          ctx.stroke();

          // If active/highlighted, render type tag bubble
          if (isHighlighted) {
            ctx.save();
            ctx.font = 'bold 10px monospace';
            const label = ev.type;
            const textWidth = ctx.measureText(label).width;
            const padX = 6;
            const bubbleW = textWidth + padX * 2;
            const bubbleH = 18;
            const bubbleX = Math.max(4, Math.min(width - bubbleW - 4, x - bubbleW / 2));
            const bubbleY = diamondY + 8;

            ctx.fillStyle = '#0B0D12';
            ctx.strokeStyle = '#B6FF3B';
            ctx.lineWidth = 1;
            ctx.fillRect(bubbleX, bubbleY, bubbleW, bubbleH);
            ctx.strokeRect(bubbleX, bubbleY, bubbleW, bubbleH);

            ctx.fillStyle = '#B6FF3B';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, bubbleX + padX, bubbleY + bubbleH / 2);
            ctx.restore();
          }
        }
      }

      // 6. Draw Playhead synced to video
      const playheadX = (currentTime / duration) * width;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // Playhead head cap
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(playheadX - 4, 0);
      ctx.lineTo(playheadX + 4, 0);
      ctx.lineTo(playheadX, 6);
      ctx.closePath();
      ctx.fill();
    },
    [bundle, duration, events]
  );

  // Handle canvas resize
  useEffect(() => {
    const handleResize = () => {
      if (!containerRef.current || !canvasRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvasRef.current.width = Math.round(rect.width * dpr);
      canvasRef.current.height = Math.round(96 * dpr);
      canvasRef.current.style.width = `${rect.width}px`;
      canvasRef.current.style.height = '96px';
      const videoEl = videoRef.current;
      draw(videoEl ? videoEl.currentTime : 0, activeEvent);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw, videoRef, activeEvent]);

  // Sync playhead with video element at at most 10 fps (100 ms interval)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) {
      draw(0, activeEvent);
      return;
    }

    let animationFrameId: number;

    const tick = () => {
      const now = performance.now();
      if (now - lastDrawTimeRef.current >= 100) {
        lastDrawTimeRef.current = now;
        draw(videoEl.currentTime, activeEvent);
      }
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);

    const onSeekedOrPaused = () => {
      lastDrawTimeRef.current = performance.now();
      draw(videoEl.currentTime, activeEvent);
    };

    videoEl.addEventListener('seeked', onSeekedOrPaused);
    videoEl.addEventListener('pause', onSeekedOrPaused);
    videoEl.addEventListener('play', onSeekedOrPaused);

    return () => {
      cancelAnimationFrame(animationFrameId);
      videoEl.removeEventListener('seeked', onSeekedOrPaused);
      videoEl.removeEventListener('pause', onSeekedOrPaused);
      videoEl.removeEventListener('play', onSeekedOrPaused);
    };
  }, [videoRef, draw, activeEvent]);

  // Click/tap handling:
  // If clicking near a diamond (within 8px), seek to 0.5s before it and highlight.
  // Otherwise seek to clicked timeline position.
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    const targetTime = fraction * duration;

    // Check for nearby event within 10 CSS pixels
    let clickedEvent: SfxEvent | null = null;
    let minDistance = 10;

    for (const ev of events) {
      const evX = (ev.time / duration) * rect.width;
      const dist = Math.abs(evX - clickX);
      if (dist < minDistance) {
        minDistance = dist;
        clickedEvent = ev;
      }
    }

    if (clickedEvent) {
      setActiveEvent(clickedEvent);
      onSelectEvent?.(clickedEvent);
      // "Tapping an event seeks the video to 0.5 s before it."
      const seekTime = Math.max(0, clickedEvent.time - 0.5);
      onSeek(seekTime);
      draw(seekTime, clickedEvent);
    } else {
      setActiveEvent(null);
      onSeek(targetTime);
      draw(targetTime, null);
    }
  };

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-[var(--text)] uppercase tracking-wider text-[11px]">
            Timeline View
          </span>
          <span className="text-[11px] text-[var(--text-2)]">
            Tap timeline or ◆ to seek (-0.5s)
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          {events.length > 0 && (
            <div className="flex items-center gap-1.5 text-[var(--volt)]">
              <span className="text-[10px]">◆</span>
              <span>SFX</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="w-1 h-2 bg-[var(--text-2)]" />
            <span>Transients</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-0.5 h-2.5 bg-white" />
            <span>Cuts</span>
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] overflow-hidden cursor-pointer hover:border-[var(--volt)]/50 transition-colors"
      >
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          className="w-full h-[96px] block"
        />
      </div>

      <div className="flex justify-between text-[11px] font-mono text-[var(--text-2)] px-1">
        <span>0:00</span>
        {activeEvent && (
          <span className="text-[var(--volt)]">
            ◆ {activeEvent.type} at {activeEvent.time.toFixed(2)}s
          </span>
        )}
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}
