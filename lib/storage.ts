import { get, set, del, keys } from 'idb-keyval';

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
}

const PROJECTS_KEY = 'sfx_ai_projects_list';
const VIDEO_KEY_PREFIX = 'sfx_ai_video_blob_';

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
 * Delete a project and its associated video blob.
 */
export async function deleteStoredProject(projectId: string): Promise<void> {
  try {
    const current = await getStoredProjects();
    const updated = current.filter((p) => p.id !== projectId);
    await saveStoredProjects(updated);
    await del(`${VIDEO_KEY_PREFIX}${projectId}`);
  } catch (err) {
    console.error(`Failed to delete project ${projectId}:`, err);
    throw err;
  }
}

/**
 * Clear all project metadata and video blobs from IndexedDB.
 */
export async function clearAllStoredData(): Promise<void> {
  try {
    const allKeys = await keys();
    for (const key of allKeys) {
      if (typeof key === 'string' && (key.startsWith('sfx_ai_') || key === PROJECTS_KEY)) {
        await del(key);
      }
    }
    await del(PROJECTS_KEY);
  } catch (err) {
    console.error('Failed to clear stored data:', err);
    throw err;
  }
}
