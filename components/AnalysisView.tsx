'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { AnalysisBundle } from '@/types/analysis';
import { formatDuration } from '@/lib/format';

interface AnalysisViewProps {
  bundle: AnalysisBundle;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onSeek: (targetTime: number) => void;
}

export function AnalysisView({ bundle, videoRef, onSeek }: AnalysisViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastDrawTimeRef = useRef<number>(0);

  const duration = bundle.duration || 1;

  const draw = useCallback((currentTime: number) => {
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
      const maxAmpHeight = height * 0.42;

      ctx.fillStyle = 'rgba(182, 255, 59, 0.28)'; // volt with alpha
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
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1;
      for (const cut of bundle.cuts) {
        const x = (cut.t / duration) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Small cut tick at top
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(x - 1, 0, 3, 4);
      }
    }

    // 4. Draw Transient Markers (small volt dots)
    if (bundle.transients && bundle.transients.length > 0) {
      ctx.fillStyle = '#B6FF3B'; // volt
      for (const tr of bundle.transients) {
        const x = (tr.t / duration) * width;
        ctx.beginPath();
        ctx.arc(x, 10, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 5. Draw Playhead synced to video
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
  }, [bundle, duration]);

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
      draw(videoEl ? videoEl.currentTime : 0);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw, videoRef]);

  // Sync playhead with video element at at most 10 fps (100 ms interval)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) {
      draw(0);
      return;
    }

    let animationFrameId: number;

    const tick = () => {
      const now = performance.now();
      if (now - lastDrawTimeRef.current >= 100) {
        lastDrawTimeRef.current = now;
        draw(videoEl.currentTime);
      }
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);

    const onSeekedOrPaused = () => {
      lastDrawTimeRef.current = performance.now();
      draw(videoEl.currentTime);
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
  }, [videoRef, draw]);

  // Click/tap to seek
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    const targetTime = fraction * duration;
    onSeek(targetTime);
    draw(targetTime);
  };

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between text-xs text-[var(--text-2)] font-mono">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-[var(--text)] uppercase tracking-wider text-[11px]">
            Analysis View
          </span>
          <span className="text-[11px] text-[var(--text-2)]">
            Tap timeline to seek
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--volt)]" />
            <span>Waveform / Transients</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-0.5 h-2.5 bg-white" />
            <span>Scene cuts</span>
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
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}
