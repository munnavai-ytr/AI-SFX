'use client';

import React, { useState } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { pickVideo } from '@/platform/pick-video';
import { useToast } from '@/components/Toast';
import { formatDuration, formatDate } from '@/lib/format';
import { Settings, Plus, Film, Trash2, AlertTriangle, Loader2 } from 'lucide-react';

import { useShallow } from 'zustand/react/shallow';

export function HomeScreen() {
  const {
    projects,
    isLoadingProjects,
    openSettings,
    openProject,
    deleteProject,
    createProjectFromFile,
  } = useAppStore(
    useShallow((s) => ({
      projects: s.projects,
      isLoadingProjects: s.isLoadingProjects,
      openSettings: s.openSettings,
      openProject: s.openProject,
      deleteProject: s.deleteProject,
      createProjectFromFile: s.createProjectFromFile,
    }))
  );

  const { showToast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  const handlePickVideo = async () => {
    if (isProcessingFile) return;
    try {
      const file = await pickVideo();
      if (!file) return;

      if (!file.type.startsWith('video/')) {
        showToast('Please select a valid video file (video/*).', 'error');
        return;
      }

      setIsProcessingFile(true);
      await createProjectFromFile(file);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setIsProcessingFile(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (isProcessingFile) return;

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file.type.startsWith('video/')) {
      showToast('Dropped file is not a supported video file.', 'error');
      return;
    }

    try {
      setIsProcessingFile(true);
      await createProjectFromFile(file);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setIsProcessingFile(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    try {
      await deleteProject(id);
      showToast(`Deleted "${name}"`);
    } catch (err) {
      showToast(`Failed to delete: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ink)] text-[var(--text)]">
      {/* Top Header */}
      <header className="border-b border-[var(--ink-3)] safe-padding-top px-4 sm:px-8 py-4 bg-[var(--ink)] sticky top-0 z-20">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[8px] bg-[var(--volt)] flex items-center justify-center text-[var(--volt-ink)] font-bold text-sm tracking-tight select-none">
              SFX
            </div>
            <span className="text-lg font-bold tracking-tight text-[var(--text)] select-none">
              SFX AI
            </span>
          </div>

          <button
            type="button"
            onClick={openSettings}
            aria-label="Settings"
            className="w-11 h-11 flex items-center justify-center rounded-[10px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--ink-2)] border border-transparent hover:border-[var(--ink-3)] transition-colors min-h-[44px] min-w-[44px]"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-8 safe-padding-bottom">
        {/* Upload Drop Zone / Button */}
        <section aria-labelledby="upload-section-title">
          <h2 id="upload-section-title" className="sr-only">Upload video</h2>
          <div
            onClick={handlePickVideo}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePickVideo();
              }
            }}
            aria-label="Add video button and drop zone"
            className={`w-full relative group cursor-pointer transition-all duration-200 rounded-[var(--radius)] border-2 border-dashed p-8 sm:p-12 flex flex-col items-center justify-center text-center bg-[var(--ink-2)] min-h-[220px] ${
              isDragging
                ? 'border-[var(--volt)] bg-[var(--ink-3)] glow-volt'
                : 'border-[var(--ink-3)] hover:border-[var(--volt)]/60 hover:bg-[var(--ink-2)]/90'
            }`}
          >
            <div className="w-14 h-14 rounded-full bg-[var(--ink-3)] group-hover:bg-[var(--volt)]/15 border border-[var(--ink-3)] flex items-center justify-center text-[var(--volt)] transition-colors mb-4">
              {isProcessingFile ? (
                <Loader2 className="w-7 h-7 animate-spin text-[var(--volt)]" />
              ) : (
                <Plus className="w-7 h-7" />
              )}
            </div>

            <h3 className="text-lg font-bold text-[var(--text)] mb-1">
              Add video
            </h3>
            <p className="text-xs sm:text-sm text-[var(--text-2)] max-w-sm leading-relaxed">
              Click to choose or drag and drop a video file
            </p>
            <div className="mt-4 flex items-center gap-2 text-xs text-[var(--text-2)] font-mono">
              <span>Max 150 MB</span>
              <span aria-hidden="true">·</span>
              <span>Max 120s</span>
            </div>
          </div>
        </section>

        {/* Recent Projects Section */}
        <section aria-labelledby="recent-projects-heading" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 id="recent-projects-heading" className="text-sm font-semibold tracking-wide text-[var(--text-2)] uppercase">
              Recent projects
            </h2>
            {projects.length > 0 && (
              <span className="text-xs text-[var(--text-2)] font-mono tabular-nums">
                {projects.length} {projects.length === 1 ? 'project' : 'projects'}
              </span>
            )}
          </div>

          {isLoadingProjects ? (
            <div className="p-12 flex flex-col items-center justify-center text-[var(--text-2)] text-sm gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--volt)]" />
              <span>Loading projects...</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-[var(--radius)] bg-[var(--ink-2)] border border-[var(--ink-3)] p-12 text-center flex flex-col items-center justify-center">
              <Film className="w-10 h-10 text-[var(--text-2)]/40 mb-3" />
              <p className="text-sm text-[var(--text-2)] font-medium">
                No projects yet
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {projects.map((project) => (
                <div
                  key={project.id}
                  onClick={() => openProject(project.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openProject(project.id);
                    }
                  }}
                  className="group relative flex items-center gap-4 p-3.5 rounded-[12px] bg-[var(--ink-2)] border border-[var(--ink-3)] hover:border-[var(--volt)]/50 hover:bg-[var(--ink-3)]/40 transition-all text-left cursor-pointer min-h-[72px]"
                >
                  {/* Thumbnail */}
                  <div className="w-20 h-14 rounded-[8px] bg-[var(--ink)] border border-[var(--ink-3)] overflow-hidden shrink-0 flex items-center justify-center relative">
                    {project.thumbnailDataUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={project.thumbnailDataUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <Film className="w-5 h-5 text-[var(--text-2)]/50" />
                    )}

                    {project.status === 'ready' && project.duration > 0 && (
                      <span className="absolute bottom-1 right-1 bg-black/85 text-[10px] text-[var(--text)] font-mono px-1 py-0.2 rounded font-medium tabular-nums">
                        {formatDuration(project.duration)}
                      </span>
                    )}

                    {project.status === 'saving' && (
                      <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--volt)]" />
                      </div>
                    )}
                    {project.status === 'probing' && (
                      <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--volt)]" />
                      </div>
                    )}
                    {project.status === 'failed' && (
                      <div className="absolute inset-0 bg-black/70 flex items-center justify-center text-[var(--danger)]">
                        <AlertTriangle className="w-4 h-4" />
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="flex-1 min-w-0 pr-8">
                    <p className="text-sm font-semibold text-[var(--text)] truncate group-hover:text-[var(--volt)] transition-colors">
                      {project.name}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-[var(--text-2)] mt-1 font-mono">
                      {project.status === 'failed' ? (
                        <span className="text-[var(--danger)] font-sans truncate">
                          {project.error || 'Failed'}
                        </span>
                      ) : project.status === 'saving' ? (
                        <span className="text-[var(--volt)] font-sans">Saving video...</span>
                      ) : project.status === 'probing' ? (
                        <span className="text-[var(--volt)] font-sans">Reading info...</span>
                      ) : (
                        <>
                          <span>{formatDuration(project.duration)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatDate(project.createdAt)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Delete button */}
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, project.id, project.name)}
                    aria-label={`Delete project ${project.name}`}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-[8px] text-[var(--text-2)]/60 hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors opacity-80 group-hover:opacity-100"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
