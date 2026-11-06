import { create } from 'zustand';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface AnalysisStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  progress?: number; // 0 to 100 real percentage
}

export interface AnalysisState {
  running: boolean;
  steps: AnalysisStep[];
  startRun(steps: { id: string; label: string }[]): void;
  setStep(id: string, patch: Partial<AnalysisStep>): void;
  finish(): void;
  reset(): void;
  cancelRequested: boolean;
  requestCancel(): void;
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  running: false,
  steps: [],
  cancelRequested: false,

  startRun: (initialSteps) =>
    set({
      running: true,
      cancelRequested: false,
      steps: initialSteps.map((s, index) => ({
        id: s.id,
        label: s.label,
        status: index === 0 ? 'running' : 'pending',
        startedAt: index === 0 ? Date.now() : undefined,
      })),
    }),

  setStep: (id, patch) =>
    set((state) => ({
      steps: state.steps.map((step) =>
        step.id === id ? { ...step, ...patch } : step
      ),
    })),

  finish: () =>
    set({
      running: false,
    }),

  reset: () =>
    set({
      running: false,
      steps: [],
      cancelRequested: false,
    }),

  requestCancel: () =>
    set({
      cancelRequested: true,
    }),
}));
