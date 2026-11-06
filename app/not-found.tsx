'use client';

import React from 'react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[var(--ink)] text-[var(--text)] flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-2xl font-bold mb-2">404 - Page Not Found</h1>
      <p className="text-sm text-[var(--text-2)] mb-6">The requested page could not be found.</p>
      <Link
        href="/"
        className="px-5 py-2.5 rounded-[10px] bg-[var(--volt)] text-[var(--volt-ink)] text-sm font-semibold hover:opacity-95 transition-opacity"
      >
        Return to SFX AI
      </Link>
    </div>
  );
}
