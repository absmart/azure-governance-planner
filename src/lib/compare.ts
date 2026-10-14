// Compares two policy snapshots (designs or an Azure import): which policies
// each puts in effect, which assignments and management groups differ, and how
// each covers the frameworks' controls.

import type { Catalog } from './catalog';
import { inNistBaseline, type Baseline } from './engine';
import { enforces, evaluates, type PolicySnapshot, type SnapshotAssignment } from './snapshot';

/** Where a policy is in effect on one side. */
export interface Placement {
  scope: string;
  scopeName: string;
  assignment: string;
  effect: string;
  enforced: boolean;
}

export interface PolicyComparison {
  /** Built-in GUID or custom definition name. */
  p: string;
  a: Placement[];
  b: Placement[];
  side: 'both' | 'a' | 'b';
  /** In both, but enforced on one side only. */
  enforcementDiffers: boolean;
}

export interface OverlapCounts {
  onlyA: number;
  both: number;
  onlyB: number;
}

/** Every policy either side evaluates (not Disabled, system assignments left out unless asked). */
export function comparePolicies(a: PolicySnapshot, b: PolicySnapshot, options: { includeSystem?: boolean } = {}): PolicyComparison[] {
  const placements = (s: PolicySnapshot) => {
    const names = new Map(s.mgs.map((m) => [m.id, m.displayName]));
    const out = new Map<string, Placement[]>();
    for (const x of s.assignments) {
      if (x.system && !options.includeSystem) continue;
      for (const m of x.members) {
        if (!evaluates(m)) continue;
        const list = out.get(m.p) ?? [];
        list.push({ scope: x.scope, scopeName: names.get(x.scope) ?? x.scope, assignment: x.name, effect: m.e || 'unknown', enforced: enforces(x, m) });
        out.set(m.p, list);
      }
    }
    return out;
  };
  const pa = placements(a);
  const pb = placements(b);
  return [...new Set([...pa.keys(), ...pb.keys()])].map((p) => {
    const inA = pa.get(p) ?? [];
    const inB = pb.get(p) ?? [];
    return {
      p,
      a: inA,
      b: inB,
      side: inA.length && inB.length ? 'both' : inA.length ? 'a' : 'b',
      enforcementDiffers: !!(inA.length && inB.length) && inA.some((x) => x.enforced) !== inB.some((x) => x.enforced),
    };
  });
}

/** Venn counts, for all evaluated policies or the enforced ones only. */
export function overlap(rows: PolicyComparison[], enforcedOnly = false): OverlapCounts {
  const inA = (r: PolicyComparison) => (enforcedOnly ? r.a.some((x) => x.enforced) : r.a.length > 0);
  const inB = (r: PolicyComparison) => (enforcedOnly ? r.b.some((x) => x.enforced) : r.b.length > 0);
  let onlyA = 0;
  let both = 0;
  let onlyB = 0;
  for (const r of rows) {
    if (inA(r) && inB(r)) both++;
    else if (inA(r)) onlyA++;
    else if (inB(r)) onlyB++;
  }
  return { onlyA, both, onlyB };
}

export interface AssignmentComparison {
  definitionKey: string;
  definitionName: string;
  a: SnapshotAssignment[];
  b: SnapshotAssignment[];
  side: 'both' | 'a' | 'b';
  /** For definitions on both sides: where and how they differ. */
  differences: string[];
}

/** Assignments matched by definition (built-in GUID or custom name), wherever they're assigned. */
export function compareAssignments(a: PolicySnapshot, b: PolicySnapshot, options: { includeSystem?: boolean } = {}): AssignmentComparison[] {
  const group = (s: PolicySnapshot) => {
    const out = new Map<string, SnapshotAssignment[]>();
    for (const x of s.assignments) if (!x.system || options.includeSystem) out.set(x.definitionKey, [...(out.get(x.definitionKey) ?? []), x]);
    return out;
  };
  const ga = group(a);
  const gb = group(b);
  const scopeName = (s: PolicySnapshot, id: string) => s.mgs.find((m) => m.id === id)?.displayName ?? id;
  return [...new Set([...ga.keys(), ...gb.keys()])]
    .map((key) => {
      const inA = ga.get(key) ?? [];
      const inB = gb.get(key) ?? [];
      const differences: string[] = [];
      if (inA.length && inB.length) {
        const scopesA = new Set(inA.map((x) => x.scope.toLowerCase()));
        const scopesB = new Set(inB.map((x) => x.scope.toLowerCase()));
        if ([...scopesA].sort().join() !== [...scopesB].sort().join())
          differences.push(
            `assigned at ${inA.map((x) => scopeName(a, x.scope)).join(', ')} vs ${inB.map((x) => scopeName(b, x.scope)).join(', ')}`,
          );
        const modeA = [...new Set(inA.map((x) => x.enforcementMode))].join('/');
        const modeB = [...new Set(inB.map((x) => x.enforcementMode))].join('/');
        if (modeA !== modeB) differences.push(`enforcement ${modeA} vs ${modeB}`);
      }
      return {
        definitionKey: key,
        definitionName: (inA[0] ?? inB[0]).definitionName,
        a: inA,
        b: inB,
        side: (inA.length && inB.length ? 'both' : inA.length ? 'a' : 'b') as AssignmentComparison['side'],
        differences,
      };
    })
    .sort((x, y) => x.definitionName.localeCompare(y.definitionName));
}

export interface MgComparison {
  id: string;
  displayName: string;
  side: 'both' | 'a' | 'b';
}

/** Management groups (and other assignment scopes) matched by ID. */
export function compareMgs(a: PolicySnapshot, b: PolicySnapshot): MgComparison[] {
  const ids = new Map<string, MgComparison>();
  for (const m of a.mgs) ids.set(m.id.toLowerCase(), { id: m.id, displayName: m.displayName, side: 'a' });
  for (const m of b.mgs) {
    const seen = ids.get(m.id.toLowerCase());
    ids.set(m.id.toLowerCase(), seen ? { ...seen, side: 'both' } : { id: m.id, displayName: m.displayName, side: 'b' });
  }
  return [...ids.values()];
}

/** How a side covers one control, from policies alone. */
export type SnapshotControlStatus = 'enforced' | 'audited' | 'manual' | 'missing' | 'none';

export interface SnapshotCoverage {
  framework: string;
  short: string;
  counts: Record<SnapshotControlStatus, number>;
  controls: Map<string, SnapshotControlStatus>;
}

/**
 * Framework coverage of a snapshot: enforced when an enforced assignment
 * carries one of the control's automated policies, audited when any evaluates
 * one, manual when it has only manual policies, missing when none of its
 * automated policies is assigned, none when no policy maps to it.
 */
export function snapshotCoverage(
  catalog: Catalog,
  s: PolicySnapshot,
  frameworkKey: string,
  nist: { baseline: Baseline; privacy: boolean } = { baseline: 'all', privacy: false },
): SnapshotCoverage | null {
  const f = catalog.frameworks.find((x) => x.key === frameworkKey);
  if (!f) return null;
  const enforced = new Set<string>();
  const evaluated = new Set<string>();
  for (const x of s.assignments)
    for (const m of x.members) {
      if (!evaluates(m)) continue;
      evaluated.add(m.p);
      if (enforces(x, m)) enforced.add(m.p);
    }
  const byControl = new Map<string, { automated: Set<string>; manual: number }>();
  for (const c of f.controls) byControl.set(c, { automated: new Set(), manual: 0 });
  for (const ref of f.refs) {
    const manual = ref.e === 'Manual' || catalog.policies[ref.p]?.e === 'Manual';
    for (const c of ref.g) {
      const entry = byControl.get(c) ?? { automated: new Set<string>(), manual: 0 };
      byControl.set(c, entry);
      if (manual) entry.manual++;
      else entry.automated.add(ref.p);
    }
  }
  const counts: Record<SnapshotControlStatus, number> = { enforced: 0, audited: 0, manual: 0, missing: 0, none: 0 };
  const controls = new Map<string, SnapshotControlStatus>();
  for (const [id, entry] of byControl) {
    if (f.nist && !inNistBaseline(catalog, id, nist.baseline, nist.privacy)) continue;
    const automated = [...entry.automated];
    const status: SnapshotControlStatus = automated.some((p) => enforced.has(p))
      ? 'enforced'
      : automated.some((p) => evaluated.has(p))
        ? 'audited'
        : automated.length
          ? 'missing'
          : entry.manual
            ? 'manual'
            : 'none';
    controls.set(id, status);
    counts[status]++;
  }
  return { framework: f.key, short: f.short, counts, controls };
}

/** Controls whose status differs between the two sides. */
export function coverageDifferences(a: SnapshotCoverage, b: SnapshotCoverage): { control: string; a: SnapshotControlStatus; b: SnapshotControlStatus }[] {
  return [...a.controls]
    .filter(([id, status]) => b.controls.get(id) !== status)
    .map(([id, status]) => ({ control: id, a: status, b: b.controls.get(id) ?? 'none' }))
    .sort((x, y) => x.control.localeCompare(y.control, 'en', { numeric: true }));
}
