'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { RotateCw, AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error caught by RootErrorBoundary:', error, errorInfo);
  }

  handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[var(--ink)] text-[var(--text)] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[var(--ink-2)] border border-[var(--ink-3)] rounded-[var(--radius)] p-6 sm:p-8 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--danger)]/15 border border-[var(--danger)]/30 flex items-center justify-center text-[var(--danger)] mb-4">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight mb-2">Something went wrong</h1>
            <p className="text-sm text-[var(--text-2)] mb-6 leading-relaxed">
              {this.state.error?.message || 'An unexpected application error occurred.'}
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-[12px] bg-[var(--volt)] text-[var(--volt-ink)] font-semibold text-sm hover:opacity-95 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--volt)] min-h-[44px]"
            >
              <RotateCw className="w-4 h-4" />
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
