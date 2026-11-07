import { create } from 'zustand';
import {
  ProjectMetadata,
  getStoredProjects,
  saveStoredProjects,
  saveVideoBlob,
  getVideoBlob,
  deleteStoredProject,
  clearAllStoredData,
  requestStoragePersistence,
} from '@/lib/storage';
import { probeVideoFile, validateVideoFileSize } from '@/lib/probe-video';

export type ScreenType = 'home' | 'analyzing' | 'studio';

export interface KeyTestState {
  tested: boolean;
  valid: boolean;
  modelCount?: number;
  testedAt?: number;
  error?: string;
  testing?: boolean;
}

export interface AppState {
  screen: ScreenType;
  activeProjectId: string | null;
  isSettingsOpen: boolean;
  projects: ProjectMetadata[];
  isLoadingProjects: boolean;

  // Gemini API key state
  apiKey: string;
  keyTestState: KeyTestState;

  // Actions
  setScreen: (screen: ScreenType) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setApiKey: (key: string) => void;
  testApiKey: () => Promise<void>;

  // Project Actions
  loadProjects: () => Promise<void>;
  openProject: (projectId: string) => void;
  createProjectFromFile: (file: File) => Promise<string | null>;
  retryProject: (projectId: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  clearAllData: () => Promise<void>;
}

const API_KEY_STORAGE_KEY = 'sfx_ai_gemini_api_key';
const KEY_TEST_STORAGE_KEY = 'sfx_ai_gemini_key_test_state';

// Safe localStorage helpers
function getStoredApiKey(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveApiKeyToStorage(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (key) {
      localStorage.setItem(API_KEY_STORAGE_KEY, key);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  } catch (err) {
    console.warn('Failed to save API key to localStorage:', err);
  }
}

function getStoredKeyTest(): KeyTestState {
  if (typeof window === 'undefined') {
    return { tested: false, valid: false };
  }
  try {
    const raw = localStorage.getItem(KEY_TEST_STORAGE_KEY);
    if (!raw) return { tested: false, valid: false };
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return { tested: false, valid: false };
  }
}

function saveKeyTestToStorage(state: KeyTestState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEY_TEST_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Failed to save test state to localStorage:', err);
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: 'home',
  activeProjectId: null,
  isSettingsOpen: false,
  projects: [],
  isLoadingProjects: true,
  apiKey: getStoredApiKey(),
  keyTestState: getStoredKeyTest(),

  setScreen: (screen) => set({ screen }),
  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),

  setApiKey: (key) => {
    saveApiKeyToStorage(key);
    // Reset test state whenever the key changes
    const newTestState: KeyTestState = { tested: false, valid: false };
    saveKeyTestToStorage(newTestState);
    set({ apiKey: key, keyTestState: newTestState });
  },

  testApiKey: async () => {
    const key = get().apiKey.trim();
    if (!key) {
      const failedState: KeyTestState = {
        tested: true,
        valid: false,
        testedAt: Date.now(),
        error: 'Please enter a Gemini API key first.',
      };
      set({ keyTestState: failedState });
      saveKeyTestToStorage(failedState);
      return;
    }

    set((state) => ({
      keyTestState: { ...state.keyTestState, testing: true },
    }));

    try {
      const { discoverGeminiModels } = await import('@/ai/gemini');
      const models = await discoverGeminiModels(key, true);

      const successState: KeyTestState = {
        tested: true,
        valid: true,
        modelCount: models.length,
        testedAt: Date.now(),
        testing: false,
      };
      set({ keyTestState: successState });
      saveKeyTestToStorage(successState);
    } catch (netErr) {
      const netErrState: KeyTestState = {
        tested: true,
        valid: false,
        testedAt: Date.now(),
        error: (netErr as Error).message || 'Network request failed. Check internet connection.',
        testing: false,
      };
      set({ keyTestState: netErrState });
      saveKeyTestToStorage(netErrState);
    }
  },

  loadProjects: async () => {
    set({ isLoadingProjects: true });
    await requestStoragePersistence();
    try {
      const { useKeyStore } = await import('@/stores/use-key-store');
      await useKeyStore.getState().init();
    } catch (err) {
      console.warn('Failed to initialize key store:', err);
    }
    const stored = await getStoredProjects();
    set({ projects: stored, isLoadingProjects: false });
  },

  openProject: (projectId: string) => {
    set({ activeProjectId: projectId, screen: 'studio' });
  },

  createProjectFromFile: async (file: File): Promise<string | null> => {
    const projectId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `proj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Validate size limit early
    try {
      validateVideoFileSize(file);
    } catch (sizeErr) {
      const errProject: ProjectMetadata = {
        id: projectId,
        name: file.name,
        createdAt: Date.now(),
        duration: 0,
        width: 0,
        height: 0,
        size: file.size,
        status: 'failed',
        error: (sizeErr as Error).message,
      };
      const updated = [errProject, ...get().projects];
      set({ projects: updated, activeProjectId: projectId, screen: 'studio' });
      await saveStoredProjects(updated);
      return projectId;
    }

    // Initial state: saving video
    const newProject: ProjectMetadata = {
      id: projectId,
      name: file.name,
      createdAt: Date.now(),
      lastModified: file.lastModified || Date.now(),
      duration: 0,
      width: 0,
      height: 0,
      size: file.size,
      status: 'saving',
    };

    const initialProjects = [newProject, ...get().projects];
    set({ projects: initialProjects, activeProjectId: projectId, screen: 'studio' });
    await saveStoredProjects(initialProjects);

    // Save video blob in IndexedDB
    try {
      await saveVideoBlob(projectId, file);
    } catch (saveErr) {
      const failedProjects = get().projects.map((p) =>
        p.id === projectId
          ? { ...p, status: 'failed' as const, error: `Failed to save video: ${(saveErr as Error).message}` }
          : p
      );
      set({ projects: failedProjects });
      await saveStoredProjects(failedProjects);
      return projectId;
    }

    // Step 2: reading video info (probing)
    const probingProjects = get().projects.map((p) =>
      p.id === projectId ? { ...p, status: 'probing' as const } : p
    );
    set({ projects: probingProjects });
    await saveStoredProjects(probingProjects);

    // Probe metadata & extract thumbnail
    try {
      const probeResult = await probeVideoFile(file);
      const readyProjects = get().projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              status: 'ready' as const,
              duration: probeResult.duration,
              width: probeResult.width,
              height: probeResult.height,
              thumbnailDataUrl: probeResult.thumbnailDataUrl,
              error: undefined,
            }
          : p
      );
      set({ projects: readyProjects });
      await saveStoredProjects(readyProjects);
      return projectId;
    } catch (probeErr) {
      const failedProjects = get().projects.map((p) =>
        p.id === projectId
          ? { ...p, status: 'failed' as const, error: (probeErr as Error).message }
          : p
      );
      set({ projects: failedProjects });
      await saveStoredProjects(failedProjects);
      return projectId;
    }
  },

  retryProject: async (projectId: string) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    // Retrieve saved blob
    const blob = await getVideoBlob(projectId);
    if (!blob) {
      const failedProjects = get().projects.map((p) =>
        p.id === projectId
          ? { ...p, status: 'failed' as const, error: 'Original video file not found in storage. Please upload again.' }
          : p
      );
      set({ projects: failedProjects });
      await saveStoredProjects(failedProjects);
      return;
    }

    // Set status to probing
    const probingProjects = get().projects.map((p) =>
      p.id === projectId ? { ...p, status: 'probing' as const, error: undefined } : p
    );
    set({ projects: probingProjects });
    await saveStoredProjects(probingProjects);

    try {
      const probeResult = await probeVideoFile(blob);
      const readyProjects = get().projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              status: 'ready' as const,
              duration: probeResult.duration,
              width: probeResult.width,
              height: probeResult.height,
              thumbnailDataUrl: probeResult.thumbnailDataUrl,
              error: undefined,
            }
          : p
      );
      set({ projects: readyProjects });
      await saveStoredProjects(readyProjects);
    } catch (retryErr) {
      const failedProjects = get().projects.map((p) =>
        p.id === projectId
          ? { ...p, status: 'failed' as const, error: (retryErr as Error).message }
          : p
      );
      set({ projects: failedProjects });
      await saveStoredProjects(failedProjects);
    }
  },

  deleteProject: async (projectId: string) => {
    await deleteStoredProject(projectId);
    const updated = get().projects.filter((p) => p.id !== projectId);
    const currentActive = get().activeProjectId;
    set({
      projects: updated,
      activeProjectId: currentActive === projectId ? null : currentActive,
      screen: currentActive === projectId ? 'home' : get().screen,
    });
  },

  clearAllData: async () => {
    await clearAllStoredData();
    set({
      projects: [],
      activeProjectId: null,
      screen: 'home',
    });
  },
}));
