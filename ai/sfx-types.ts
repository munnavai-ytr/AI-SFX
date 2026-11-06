import { get, set, del } from 'idb-keyval';

export const SFX_TYPES = {
  whoosh_fast: 'quick whoosh for hard cuts / fast transitions',
  whoosh_slow: 'longer whoosh for slow zooms / smooth transitions',
  swipe: 'light swipe for slides, wipes, UI motion',
  pop: 'short pop for text/graphics/objects appearing',
  click: 'UI click / tap',
  typing: 'keyboard typing burst',
  notification: 'phone notification',
  ding: 'bright ding for a correct/important point',
  impact_soft: 'soft thud for small emphasis',
  impact_hard: 'hard hit for strong emphasis / dramatic beat',
  boom: 'deep cinematic boom',
  bass_drop: 'bass drop for big reveal / beat drop',
  riser: 'rising tension build before a reveal',
  reverse_riser: 'reverse swell leading into a cut',
  glitch: 'digital glitch for glitch/tech transitions',
  camera_shutter: 'camera shutter for photo moments / freeze frames',
  record_scratch: 'record scratch for sudden stop / awkward comedy',
  rimshot: 'rimshot for a joke punchline',
  applause: 'short applause for achievement',
  glass_break: 'glass breaking',
  door_close: 'door closing',
  footsteps: 'footsteps for walking on screen',
  bell: 'bell / chime',
  sparkle: 'magic sparkle for something shiny/new/special',
  error_buzz: 'error buzz for wrong/fail',
  cash_register: 'cash register for money moments',
  punch: 'punch / fight hit',
  heartbeat: 'heartbeat for suspense',
  stinger_intro: 'short intro sting at video start',
  stinger_outro: 'short outro sting at video end',
} as const;

export type SfxType = keyof typeof SFX_TYPES;

export const SFX_INTENTS = [
  'transition',
  'emphasis',
  'action',
  'text_on_screen',
  'comedy',
  'emotion',
  'intro',
  'outro',
] as const;

export type SfxIntent = typeof SFX_INTENTS[number];

export interface SfxEvent {
  id: string;
  time: number; // seconds: the exact instant the sound's KEY MOMENT (peak/hit) must land
  type: SfxType;
  intent: SfxIntent;
  reason: string;
  confidence: number; // 0..1
  volume: number; // 0..1 suggested relative loudness
  snapped: 'cut' | 'transient' | 'none';
}

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface SfxPlan {
  projectId: string;
  bundleCreatedAt: number;
  createdAt: number;
  model: string;
  videoType: string;
  mood: string;
  summary: string;
  needsSfx: boolean;
  recommendedDensity: 'minimal' | 'balanced' | 'heavy';
  reasoning: string;
  speech: SpeechSegment[];
  candidates: SfxEvent[]; // after snap + validation, BEFORE density filter
  rawResponse: string; // for the debug view
}

export interface SfxEditEvent {
  id: string;
  time: number;
  type: SfxType;
  variant: number; // 0, 1, 2
  volume: number; // 0..1
  intent: SfxIntent;
  enabled: boolean;
  reason?: string;
  confidence?: number;
  snapped?: 'cut' | 'transient' | 'none';
}

export interface SfxEditState {
  projectId: string;
  events: SfxEditEvent[];
  density: 'auto' | 'minimal' | 'balanced' | 'heavy';
  masterVolume: number;
  syncOffsetMs: number;
  updatedAt: number;
  hasManualEdits?: boolean;
}

const SFX_PLAN_KEY_PREFIX = 'sfxplan:';
const SFX_EDIT_KEY_PREFIX = 'sfxedit:';

export async function saveSfxPlan(plan: SfxPlan): Promise<void> {
  try {
    await set(`${SFX_PLAN_KEY_PREFIX}${plan.projectId}`, plan);
  } catch (err) {
    console.error(`Failed to save SFX plan for project ${plan.projectId}:`, err);
    throw err;
  }
}

export async function getSfxPlan(projectId: string): Promise<SfxPlan | null> {
  try {
    const plan = await get<SfxPlan>(`${SFX_PLAN_KEY_PREFIX}${projectId}`);
    return plan || null;
  } catch (err) {
    console.error(`Failed to load SFX plan for project ${projectId}:`, err);
    return null;
  }
}

export async function deleteSfxPlan(projectId: string): Promise<void> {
  try {
    await del(`${SFX_PLAN_KEY_PREFIX}${projectId}`);
  } catch (err) {
    console.error(`Failed to delete SFX plan for project ${projectId}:`, err);
  }
}

export async function saveSfxEditState(state: SfxEditState): Promise<void> {
  try {
    await set(`${SFX_EDIT_KEY_PREFIX}${state.projectId}`, state);
  } catch (err) {
    console.error(`Failed to save SFX edit state for project ${state.projectId}:`, err);
  }
}

export async function getSfxEditState(projectId: string): Promise<SfxEditState | null> {
  try {
    const state = await get<SfxEditState>(`${SFX_EDIT_KEY_PREFIX}${projectId}`);
    return state || null;
  } catch (err) {
    console.error(`Failed to load SFX edit state for project ${projectId}:`, err);
    return null;
  }
}

export async function deleteSfxEditState(projectId: string): Promise<void> {
  try {
    await del(`${SFX_EDIT_KEY_PREFIX}${projectId}`);
  } catch (err) {
    console.error(`Failed to delete SFX edit state for project ${projectId}:`, err);
  }
}

