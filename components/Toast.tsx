'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';

interface ToastItem {
  id: string;
  message: string;
  type?: 'info' | 'error';
}

interface ToastContextValue {
  showToast: (message: string, type?: 'info' | 'error') => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    return {
      showToast: (msg: string) => {
        console.log('[Toast]', msg);
      },
    };
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: 'info' | 'error' = 'info') => {
    const id = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none px-4 max-w-md w-full"
      >
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.16 }}
              className={`pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 rounded-[12px] bg-[var(--ink-2)] border text-sm font-medium text-[var(--text)] w-full shadow-lg ${
                toast.type === 'error'
                  ? 'border-[var(--danger)] text-[var(--danger)]'
                  : 'border-[var(--ink-3)] border-l-2 border-l-[var(--volt)]'
              }`}
            >
              <span className="flex-1 text-left">{toast.message}</span>
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                aria-label="Dismiss notification"
                className="w-8 h-8 -mr-1 flex items-center justify-center text-[var(--text-2)] hover:text-[var(--text)] transition-colors rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
