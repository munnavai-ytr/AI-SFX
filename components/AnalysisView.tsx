'use client';

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { AnalysisBundle } from '@/types/analysis';
import { SfxEditEvent } from '@/ai/sfx-types';
import { formatDuration } from '@/lib/format';

interface AnalysisViewProps {
  bundle: AnalysisBundle;
  events?: SfxEditEvent[];
  selectedEventId?: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onSeek: (targetTime: number) => void;
  onSelectEvent?: (event: SfxEditEvent) => void;
  onEventTimeChange?: (id: string, newTime: number) => void;
}

export function AnalysisView({
  bundle,
  events = [],
  selectedEventId,
  videoRef,
  onSeek,
  onSelectEvent,
  onEventTimeChange,
}: AnalysisViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastDrawTimeRef = useRef<number>(0);

  const [draggingEventId, setDraggingEventId] = useState<string | null>(null);

  const duration = bundle.duration || 1;
  const cuts = React.useMemo(() => (bundle.cuts ? bundle.cuts.map((c) => c.t) : []), [bundle.cuts]);
  const transients = React.useMemo(() => (bundle.transients ? bundle.transients.map((tr) => tr.t) : []), [bundle.transients]);

  const activeEvent = events.find((e) => e.id === selectedEventId) || null;

  const draw = useCallback(
    (currentTime: number, highlightedId: string | null) => {
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
          const isHighlighted = highlightedId === ev.id;
          const isEnabled = ev.enabled !== false;

          // Diamond path
          ctx.beginPath();
          ctx.moveTo(x, diamondY - (isHighlighted ? dSize + 2 : dSize));
          ctx.lineTo(x + (isHighlighted ? dSize + 2 : dSize), diamondY);
          ctx.lineTo(x, diamondY + (isHighlighted ? dSize + 2 : dSize));
          ctx.lineTo(x - (isHighlighted ? dSize + 2 : dSize), diamondY);
          ctx.closePath();

          ctx.fillStyle = isEnabled ? '#B6FF3B' : '#9AA3B2'; // volt or grey
          ctx.fill();

          ctx.strokeStyle = isHighlighted ? '#FFFFFF' : '#0B0D12';
          ctx.lineWidth = isHighlighted ? 1.5 : 1;
          ctx.stroke();

          // Outer volt glow ring for highlighted item
          if (isHighlighted) {
            ctx.save();
            ctx.strokeStyle = 'rgba(182, 255, 59, 0.6)';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(x, diamondY, 9, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          // If active/highlighted, render type tag bubble
          if (isHighlighted) {
            ctx.save();
            ctx.font = 'bold 10px monospace';
            const label = `${ev.type} (v${ev.variant + 1})`;
            const textWidth = ctx.measureText(label).width;
            const padX = 6;
            const bubbleW = textWidth + padX * 2;
            const bubbleH = 18;
            const bubbleX = Math.max(4, Math.min(width - bubbleW - 4, x - bubbleW / 2));
            const bubbleY = diamondY + 10;

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
      draw(videoEl ? videoEl.currentTime : 0, selectedEventId || null);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw, videoRef, selectedEventId]);

  // Sync playhead with video element at at most 10 fps (100 ms interval)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) {
      draw(0, selectedEventId || null);
      return;
    }

    let animationFrameId: number;

    const tick = () => {
      const now = performance.now();
      if (now - lastDrawTimeRef.current >= 100) {
        lastDrawTimeRef.current = now;
        draw(videoEl.currentTime, selectedEventId || null);
      }
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);

    const onSeekedOrPaused = () => {
      lastDrawTimeRef.current = performance.now();
      draw(videoEl.currentTime, selectedEventId || null);
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
  }, [videoRef, draw, selectedEventId]);

  // Dragging event marker horizontally with snapping
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;

    let closest: SfxEditEvent | null = null;
    let minDist = 14;

    for (const ev of events) {
      const evX = (ev.time / duration) * rect.width;
      const dist = Math.abs(evX - clickX);
      if (dist < minDist) {
        minDist = dist;
        closest = ev;
      }
    }

    if (closest) {
      setDraggingEventId(closest.id);
      onSelectEvent?.(closest);
      const seekTime = Math.max(0, closest.time - 0.5);
      onSeek(seekTime);
    } else {
      const fraction = Math.max(0, Math.min(1, clickX / rect.width));
      const targetTime = fraction * duration;
      onSeek(targetTime);
      draw(targetTime, null);
    }
  };

  useEffect(() => {
    if (!draggingEventId) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!canvasRef.current || !draggingEventId) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      let newTime = (clickX / rect.width) * duration;

      // Snap to cuts or transients within 80 ms (0.08 s) unless Alt key held
      if (!e.altKey) {
        const snapThreshold = 0.08;
        let bestSnap: number | null = null;
        let minDiff = snapThreshold;

        for (const c of cuts) {
          const diff = Math.abs(c - newTime);
          if (diff <= minDiff) {
            minDiff = diff;
            bestSnap = c;
          }
        }
        for (const tr of transients) {
          const diff = Math.abs(tr - newTime);
          if (diff <= minDiff) {
            minDiff = diff;
            bestSnap = tr;
          }
        }

        if (bestSnap !== null) {
          newTime = bestSnap;
        }
      }

      newTime = Number(Math.min(Math.max(newTime, 0.05), duration - 0.2).toFixed(3));
      onEventTimeChange?.(draggingEventId, newTime);
    };

    const handleMouseUp = () => {
      setDraggingEventId(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingEventId, duration, cuts, transients, onEventTimeChange]);

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-[var(--text)] uppercase tracking-wider text-[11px]">
            Timeline View
          </span>
          <span className="text-[11px] text-[var(--text-2)]">
            Tap or drag ◆ (Alt disables snap)
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
          onMouseDown={handleMouseDown}
          className="w-full h-[96px] block select-none"
        />
      </div>

      <div className="flex justify-between text-[11px] font-mono text-[var(--text-2)] px-1">
        <span>0:00</span>
        {activeEvent && (
          <span className="text-[var(--volt)] font-semibold">
            ◆ {activeEvent.type} (v{activeEvent.variant + 1}) at {activeEvent.time.toFixed(2)}s
          </span>
        )}
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}
