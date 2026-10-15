import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import { changesSummary, designBaseline, designChanges } from './baseline';
import type { Catalog } from './catalog';
import { createDesign, DEFAULT_EXPORT_SETTINGS, parseBackup, toBackup } from './designs';
import { DEFAULT_INPUT, buildDesign } from './engine';

const catalog = catalogJson as unknown as Catalog;
const design = buildDesign(catalog, DEFAULT_INPUT);

describe('saved design baselines', () => {
  it('records every assignment and policy, and sees no change in the same catalog', () => {
    const b = designBaseline(catalog, design);
    expect(b.catalog).toBe(catalog.generated);
    expect(Object.keys(b.assignments)).toHaveLength(design.stats.assignments);
    expect(Object.keys(b.policies)).toHaveLength(design.stats.uniquePolicies);
    expect(designChanges(b, catalog, design)).toBeNull();
  });

  it('lists what a catalog update changed', () => {
    const b = designBaseline(catalog, design);
    // As if saved with an older catalog: one assignment wasn't there, one was in DoNotEnforce,
    // one policy ran with another effect and one policy has since gone.
    const [first, second] = Object.keys(b.assignments);
    const policy = Object.keys(b.policies)[0];
    const older = {
      ...b,
      catalog: '2026-01-01',
      alzRef: 'platform/alz/2025.09.0',
      assignments: { ...b.assignments, [second]: [b.assignments[second][0], 'DoNotEnforce', b.assignments[second][2], b.assignments[second][3]] as const },
      policies: { ...b.policies, [policy]: 'Audit|Something', 'retired-policy': 'Deny' },
    };
    delete (older.assignments as Record<string, unknown>)[first];
    const c = designChanges(older as typeof b, catalog, design)!;
    expect(c.assignmentsAdded.map((a) => a.key)).toEqual([first]);
    expect(c.assignmentsChanged).toEqual([{ key: second, displayName: b.assignments[second][3], what: `DoNotEnforce → ${b.assignments[second][1]}` }]);
    expect(c.policiesRemoved).toEqual(['retired-policy']);
    expect(c.effectsChanged).toEqual([{ p: policy, before: 'Audit|Something', after: b.policies[policy] }]);
    expect(c.total).toBe(4);
    expect(changesSummary(c)).toBe('1 assignment added, 1 assignment changed, 1 policy removed, 1 effect changed (ALZ 2025.09.0 → 2026.10.0)'.replace('2026.10.0', catalog.alz.ref.split('/').pop()!));
  });

  it('keeps the baseline in backups', () => {
    const saved = { ...createDesign(DEFAULT_INPUT, DEFAULT_EXPORT_SETTINGS), baseline: designBaseline(catalog, design) };
    const [restored] = parseBackup(JSON.stringify(toBackup([saved])));
    expect(restored.baseline).toEqual(saved.baseline);
    const [noBaseline] = parseBackup(JSON.stringify(toBackup([{ ...saved, baseline: { nonsense: true } as never }])));
    expect(noBaseline.baseline).toBeUndefined();
  });
});
