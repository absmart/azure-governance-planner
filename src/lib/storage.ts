// Browser storage for the app. Everything is per browser; storage can be
// unavailable (private windows, blocked site data), so every access is guarded.

import { DEFAULT_EXPORT_SETTINGS, migrateExportSettings, migrateInput, type SavedDesign } from './designs';
import { DEFAULT_INPUT, type DesignInput } from './engine';
import type { ExportSettings } from './iac';

export const STORAGE_KEYS = {
  /** The decisions being edited. */
  input: 'azure-governance-planner:input',
  /** Open view. */
  view: 'azure-governance-planner:view',
  /** IaC export: format, environment and per-environment values. */
  export: 'azure-governance-planner:export',
  /** Saved designs. */
  designs: 'azure-governance-planner:designs',
  /** Id of the saved design the current decisions were opened from or saved as. */
  activeDesign: 'azure-governance-planner:active-design',
  /** Policy snapshots imported from Azure, for the Compare view. */
  azureImports: 'azure-governance-planner:azure-imports',
} as const;

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** Returns false if the value couldn't be stored. */
export function writeJson(key: string, value: unknown): boolean {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

interface StoredInput {
  version: 1;
  input: Partial<DesignInput>;
}

/** Stored decisions merged over the defaults, so fields added later get their default. */
export function loadInput(): DesignInput {
  const stored = readJson<StoredInput>(STORAGE_KEYS.input);
  if (stored?.version !== 1) return DEFAULT_INPUT;
  return migrateInput(stored.input, readJson<{ excludeManualControls?: boolean }>(STORAGE_KEYS.export) ?? undefined);
}

export function loadExportSettings(): ExportSettings {
  const stored = readJson<Partial<ExportSettings>>(STORAGE_KEYS.export);
  return stored ? migrateExportSettings(stored) : DEFAULT_EXPORT_SETTINGS;
}

export function loadDesigns(): SavedDesign[] {
  const stored = readJson<SavedDesign[]>(STORAGE_KEYS.designs);
  if (!Array.isArray(stored)) return [];
  return stored.map((d) => ({
    ...d,
    input: migrateInput(d.input, d.exportSettings as { excludeManualControls?: boolean }),
    exportSettings: migrateExportSettings(d.exportSettings),
  }));
}

export function saveInput(input: DesignInput): boolean {
  return writeJson(STORAGE_KEYS.input, { version: 1, input } satisfies StoredInput);
}
