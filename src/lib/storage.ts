// Browser storage for the app. Everything is per browser; storage can be
// unavailable (private windows, blocked site data), so every access is guarded.

import { DEFAULT_INPUT, type DesignInput } from './engine';

export const STORAGE_KEYS = {
  /** The decisions being edited. */
  input: 'azure-governance-planner:input',
  /** Open view. */
  view: 'azure-governance-planner:view',
  /** IaC export: format, environment and per-environment values. */
  export: 'azure-governance-planner:export',
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
  return { ...DEFAULT_INPUT, ...stored.input };
}

export function saveInput(input: DesignInput): boolean {
  return writeJson(STORAGE_KEYS.input, { version: 1, input } satisfies StoredInput);
}
