// Saved designs: named copies of the decisions (plus the IaC export settings)
// that can be reopened later, and a JSON backup format for exporting and
// importing them.

import { DEFAULT_INPUT, type DesignInput } from './engine';
import type { ExportSettings } from './iac';

export interface SavedDesign {
  id: string;
  name: string;
  /** ISO timestamp of the last save. */
  savedAt: string;
  input: DesignInput;
  exportSettings: ExportSettings;
}

/** File format for exported designs. */
export interface DesignBackup {
  app: 'azure-governance-planner';
  version: 1;
  exportedAt: string;
  designs: SavedDesign[];
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { format: 'bicep', environment: 'prd', values: {} };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Decisions from storage or a file, with fields added since then at their defaults. */
export function migrateInput(input: Partial<DesignInput>): DesignInput {
  return { ...DEFAULT_INPUT, ...clone(input) };
}

export function migrateExportSettings(settings: Partial<ExportSettings> | undefined): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...clone(settings ?? {}), values: { ...(settings?.values ?? {}) } };
}

export function createDesign(input: DesignInput, exportSettings: ExportSettings, now = new Date()): SavedDesign {
  return {
    id: newId(),
    name: input.name.trim() || 'Untitled design',
    savedAt: now.toISOString(),
    input: clone(input),
    exportSettings: clone(exportSettings),
  };
}

/** Overwrite a saved design with the current decisions, keeping its id. */
export function updateDesign(design: SavedDesign, input: DesignInput, exportSettings: ExportSettings, now = new Date()): SavedDesign {
  return { ...createDesign(input, exportSettings, now), id: design.id };
}

export function renameDesign(design: SavedDesign, name: string): SavedDesign {
  return { ...design, name, input: { ...design.input, name } };
}

/** A copy with a new id and a name that doesn't clash with `existing`. */
export function duplicateDesign(design: SavedDesign, existing: SavedDesign[], now = new Date()): SavedDesign {
  const names = new Set(existing.map((d) => d.name));
  let name = `${design.name} (copy)`;
  for (let n = 2; names.has(name); n++) name = `${design.name} (copy ${n})`;
  return { ...renameDesign(clone(design), name), id: newId(), savedAt: now.toISOString() };
}

/** JSON with sorted keys, so the same values compare equal whatever order their keys were set in. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

/** Whether the decisions or export settings differ from what was last saved in the design. */
export function hasUnsavedChanges(design: SavedDesign | undefined, input: DesignInput, exportSettings: ExportSettings): boolean {
  return !design || stable([design.input, design.exportSettings]) !== stable([input, exportSettings]);
}

export function toBackup(designs: SavedDesign[], now = new Date()): DesignBackup {
  return { app: 'azure-governance-planner', version: 1, exportedAt: now.toISOString(), designs: clone(designs) };
}

export function backupFileName(designs: SavedDesign[], now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  if (designs.length !== 1) return `governance-designs-${date}.json`;
  const slug = designs[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
  return `governance-design-${slug}-${date}.json`;
}

const isInput = (value: unknown): value is Partial<DesignInput> => {
  const i = value as DesignInput;
  return !!i && typeof i === 'object' && Array.isArray(i.frameworks) && typeof i.enforcement === 'string';
};

/**
 * Read an exported backup (or a single design) and return its designs with
 * fresh ids, ready to add to the saved list.
 */
export function parseBackup(text: string, now = new Date()): SavedDesign[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const candidates: unknown[] = Array.isArray((data as DesignBackup)?.designs) ? (data as DesignBackup).designs : [data];
  const designs = candidates.map((c, i): SavedDesign => {
    const d = c as Partial<SavedDesign>;
    if (!isInput(d?.input)) throw new Error(`Design ${i + 1} doesn't contain decisions this app can open.`);
    const input = migrateInput(d.input);
    const name = (typeof d.name === 'string' && d.name.trim()) || input.name || 'Imported design';
    return {
      id: newId(),
      name,
      savedAt: typeof d.savedAt === 'string' ? d.savedAt : now.toISOString(),
      input: { ...input, name },
      exportSettings: migrateExportSettings(d.exportSettings),
    };
  });
  if (designs.length === 0) throw new Error('The file has no designs.');
  return designs;
}
