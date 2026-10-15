// What a saved design deployed when it was saved, so that reopening it after a
// catalog update (a new ALZ release, changed built-in initiatives) or an app
// change can say what's different. Compact: assignments with their definition,
// mode and size, and every policy with its effects.

import type { Catalog } from './catalog';
import type { Design } from './engine';
import { definitionKey } from './snapshot';

export interface DesignBaseline {
  /** catalog.generated when the baseline was taken. */
  catalog: string;
  alzRef: string;
  /** "<management group id>/<assignment name>" → [definition key, enforcement mode, policy count, display name]. */
  assignments: Record<string, [string, 'Default' | 'DoNotEnforce', number, string]>;
  /** Policy key → its effects in the design, sorted and joined with "|". */
  policies: Record<string, string>;
}

export function designBaseline(catalog: Catalog, design: Design): DesignBaseline {
  const assignments: DesignBaseline['assignments'] = {};
  const effects = new Map<string, Set<string>>();
  for (const mg of design.mgs)
    for (const a of mg.assignments) {
      assignments[`${mg.id}/${a.name}`] = [definitionKey(a.definitionId), a.enforcementMode, a.policies.length, a.displayName];
      for (const m of a.policies) {
        const set = effects.get(m.p) ?? new Set<string>();
        set.add(m.e || '?');
        effects.set(m.p, set);
      }
    }
  return {
    catalog: catalog.generated,
    alzRef: catalog.alz.ref,
    assignments,
    policies: Object.fromEntries([...effects].map(([p, s]) => [p, [...s].sort().join('|')])),
  };
}

export interface DesignChanges {
  from: { catalog: string; alzRef: string };
  to: { catalog: string; alzRef: string };
  assignmentsAdded: { key: string; displayName: string }[];
  assignmentsRemoved: { key: string; displayName: string }[];
  /** Same assignment, different definition, enforcement mode or number of policies. */
  assignmentsChanged: { key: string; displayName: string; what: string }[];
  policiesAdded: string[];
  policiesRemoved: string[];
  effectsChanged: { p: string; before: string; after: string }[];
  /** Number of changes in all. */
  total: number;
}

/** How the design deploys differently now from when the baseline was taken; null when nothing changed. */
export function designChanges(baseline: DesignBaseline, catalog: Catalog, design: Design): DesignChanges | null {
  const now = designBaseline(catalog, design);
  const added: DesignChanges['assignmentsAdded'] = [];
  const removed: DesignChanges['assignmentsRemoved'] = [];
  const changed: DesignChanges['assignmentsChanged'] = [];
  for (const [key, [def, mode, count, name]] of Object.entries(now.assignments)) {
    const was = baseline.assignments[key];
    if (!was) {
      added.push({ key, displayName: name });
      continue;
    }
    const what: string[] = [];
    if (was[0] !== def) what.push(`definition ${was[0]} → ${def}`);
    if (was[1] !== mode) what.push(`${was[1]} → ${mode}`);
    if (was[2] !== count) what.push(`${was[2]} → ${count} policies`);
    if (what.length) changed.push({ key, displayName: name, what: what.join(', ') });
  }
  for (const [key, was] of Object.entries(baseline.assignments)) if (!now.assignments[key]) removed.push({ key, displayName: was[3] });
  const policiesAdded = Object.keys(now.policies).filter((p) => !(p in baseline.policies));
  const policiesRemoved = Object.keys(baseline.policies).filter((p) => !(p in now.policies));
  const effectsChanged = Object.entries(now.policies)
    .filter(([p, e]) => p in baseline.policies && baseline.policies[p] !== e)
    .map(([p, after]) => ({ p, before: baseline.policies[p], after }));
  const total = added.length + removed.length + changed.length + policiesAdded.length + policiesRemoved.length + effectsChanged.length;
  if (!total) return null;
  return {
    from: { catalog: baseline.catalog, alzRef: baseline.alzRef },
    to: { catalog: now.catalog, alzRef: now.alzRef },
    assignmentsAdded: added,
    assignmentsRemoved: removed,
    assignmentsChanged: changed,
    policiesAdded,
    policiesRemoved,
    effectsChanged,
    total,
  };
}

/** One line for a badge or a banner. */
export function changesSummary(c: DesignChanges): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    c.assignmentsAdded.length && `${n(c.assignmentsAdded.length, 'assignment', 'assignments')} added`,
    c.assignmentsRemoved.length && `${n(c.assignmentsRemoved.length, 'assignment', 'assignments')} removed`,
    c.assignmentsChanged.length && `${n(c.assignmentsChanged.length, 'assignment', 'assignments')} changed`,
    c.policiesAdded.length && `${n(c.policiesAdded.length, 'policy', 'policies')} added`,
    c.policiesRemoved.length && `${n(c.policiesRemoved.length, 'policy', 'policies')} removed`,
    c.effectsChanged.length && `${n(c.effectsChanged.length, 'effect', 'effects')} changed`,
  ].filter(Boolean);
  const release = c.from.alzRef !== c.to.alzRef ? ` (ALZ ${c.from.alzRef.split('/').pop()} → ${c.to.alzRef.split('/').pop()})` : '';
  return `${parts.join(', ')}${release}`;
}
