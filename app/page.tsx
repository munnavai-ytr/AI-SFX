'use client';

import React, { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/use-app-store';
import { HomeScreen } from '@/components/HomeScreen';
import { StudioScreen } from '@/components/StudioScreen';
import { AnalyzingScreen } from '@/components/AnalyzingScreen';
import { SettingsModal } from '@/components/SettingsModal';

export default function Page() {
  const { screen, loadProjects } = useAppStore(
    useShallow((s) => ({ screen: s.screen, loadProjects: s.loadProjects }))
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="min-h-screen bg-[var(--ink)] text-[var(--text)]">
      {screen === 'home' && <HomeScreen />}
      {screen === 'studio' && <StudioScreen />}
      {screen === 'analyzing' && <AnalyzingScreen />}

      <SettingsModal />
    </div>
  );
}
