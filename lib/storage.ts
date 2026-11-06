import { get, set, del, keys } from 'idb-keyval';
import { AnalysisBundle } from '@/types/analysis';

export type ProjectStatus = 'saving' | 'probing' | 'ready' | 'failed';

export interface ProjectMetadata {
  id: string;
  name: string;
  createdAt: number;
  duration: number; // in seconds
  width: number;
  height: number;
  size: number; // in bytes
  thumbnailDataUrl?: string;
  status: ProjectStatus;
  error?: string;
  lastModified?: number;
}

const PROJECTS_KEY = 'sfx_ai_projects_list';
const VIDEO_KEY_PREFIX = 'sfx_ai_video_blob_';
const ANALYSIS_KEY_PREFIX = 'sfx_ai_analysis_bundle_';

/**
 * Request persistent browser storage to avoid eviction.
 */
export async function requestStoragePersistence(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      return isPersisted;
    } catch (err) {
      console.warn('Storage persist request failed:', err);
      return false;
    }
  }
  return false;
}

/**
 * Retrieve all project metadata entries from IndexedDB.
 */
export async function getStoredProjects(): Promise<ProjectMetadata[]> {
  try {
    const list = await get<ProjectMetadata[]>(PROJECTS_KEY);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('Failed to load projects from IndexedDB:', err);
    return [];
  }
}

/**
 * Save the entire list of project metadata to IndexedDB.
 */
export async function saveStoredProjects(projects: ProjectMetadata[]): Promise<void> {
  try {
    await set(PROJECTS_KEY, projects);
  } catch (err) {
    console.error('Failed to save projects to IndexedDB:', err);
    throw err;
  }
}

/**
 * Save video file blob under its own key in IndexedDB.
 */
export async function saveVideoBlob(projectId: string, file: Blob): Promise<void> {
  try {
    await set(`${VIDEO_KEY_PREFIX}${projectId}`, file);
  } catch (err) {
    console.error(`Failed to save video blob for project ${projectId}:`, err);
    throw err;
  }
}

/**
 * Retrieve video file blob from IndexedDB.
 */
export async function getVideoBlob(projectId: string): Promise<Blob | null> {
  try {
    const blob = await get<Blob>(`${VIDEO_KEY_PREFIX}${projectId}`);
    return blob || null;
  } catch (err) {
    console.error(`Failed to retrieve video blob for project ${projectId}:`, err);
    return null;
  }
}

/**
 * Save analysis bundle into IndexedDB.
 */
export async function saveAnalysisBundle(bundle: AnalysisBundle): Promise<void> {
  try {
    await set(`${ANALYSIS_KEY_PREFIX}${bundle.projectId}`, bundle);
  } catch (err) {
    console.error(`Failed to save analysis bundle for project ${bundle.projectId}:`, err);
    throw err;
  }
}

/**
 * Retrieve analysis bundle for a project from IndexedDB.
 */
export async function getAnalysisBundle(projectId: string): Promise<AnalysisBundle | null> {
  try {
    const bundle = await get<AnalysisBundle>(`${ANALYSIS_KEY_PREFIX}${projectId}`);
    return bundle || null;
  } catch (err) {
    console.error(`Failed to load analysis bundle for project ${projectId}:`, err);
    return null;
  }
}

/**
 * Delete analysis bundle for a project.
 */
export async function deleteAnalysisBundle(projectId: string): Promise<void> {
  try {
    await del(`${ANALYSIS_KEY_PREFIX}${projectId}`);
  } catch (err) {
    console.error(`Failed to delete analysis bundle for project ${projectId}:`, err);
  }
}

import { deleteSfxPlan, deleteSfxEditState } from '@/ai/sfx-types';

/**
 * Delete a project and its associated video blob, analysis bundle, sfx plan, and edit state.
 */
export async function deleteStoredProject(projectId: string): Promise<void> {
  try {
    const current = await getStoredProjects();
    const updated = current.filter((p) => p.id !== projectId);
    await saveStoredProjects(updated);
    await del(`${VIDEO_KEY_PREFIX}${projectId}`);
    await del(`${ANALYSIS_KEY_PREFIX}${projectId}`);
    await deleteSfxPlan(projectId);
    await deleteSfxEditState(projectId);
  } catch (err) {
    console.error(`Failed to delete project ${projectId}:`, err);
    throw err;
  }
}

/**
 * Clear all project metadata, video blobs, analysis bundles, and sfx plans from IndexedDB.
 */
export async function clearAllStoredData(): Promise<void> {
  try {
    const allKeys = await keys();
    for (const key of allKeys) {
      if (
        typeof key === 'string' &&
        (key.startsWith('sfx_ai_') ||
          key.startsWith('sfxplan:') ||
          key.startsWith('sfxedit:') ||
          key === PROJECTS_KEY)
      ) {
        await del(key);
      }
    }
    await del(PROJECTS_KEY);
  } catch (err) {
    console.error('Failed to clear stored data:', err);
    throw err;
  }
}
