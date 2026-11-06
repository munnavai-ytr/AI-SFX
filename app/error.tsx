'use client';

import React, { useEffect } from 'react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App Router error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[var(--ink)] text-[var(--text)] flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
      <p className="text-sm text-[var(--text-2)] mb-6 max-w-md">{error.message || 'An unexpected error occurred.'}</p>
      <button
        type="button"
        onClick={() => reset()}
        className="px-5 py-2.5 rounded-[10px] bg-[var(--volt)] text-[var(--volt-ink)] text-sm font-semibold hover:opacity-95 transition-opacity"
      >
        Try Again
      </button>
    </div>
  );
}
