import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import { complianceFixture, denyA, fixture, sub } from '../test/azureFixture';
import type { Catalog } from './catalog';
import { DEFAULT_INPUT, ENFORCING_EFFECTS, buildDesign, type DesignInput } from './engine';
import { auditFirstDesign, buildMigrationPlan, migrationMarkdown, scopeResourceId } from './migration';
import { designSnapshot, parseAzureImport, type PolicySnapshot } from './snapshot';

const catalog = catalogJson as unknown as Catalog;
const design = (input: Partial<DesignInput> = {}) => buildDesign(catalog, { ...DEFAULT_INPUT, ...input });
const tenant = parseAzureImport([fixture(), complianceFixture()], catalog, 'Tenant');
const phase = (plan: ReturnType<typeof buildMigrationPlan>, key: string) => plan.phases.find((p) => p.key === key)!.steps;

describe('migration plan', () => {
  // The fixture tenant has contoso and contoso-landingzones, like the default design's prefix.
  const d = design();
  const plan = buildMigrationPlan(d, 'Target', tenant);

  it('creates the management groups that are missing and keeps the rest', () => {
    expect(plan.matchedMgs).toBe(2);
    expect(plan.existing.managementGroups).toEqual(['contoso', 'contoso-landingzones']);
    expect(phase(plan, 'groups').map((s) => s.scope)).toEqual(d.mgs.map((m) => m.id).filter((id) => !['contoso', 'contoso-landingzones'].includes(id)));
  });

  it('adds what would block or remediate in DoNotEnforce first, then enforces it', () => {
    const enforcing = d.mgs.flatMap((m) =>
      m.assignments.filter((a) => a.enforcementMode === 'Default' && a.policies.some((p) => ENFORCING_EFFECTS.has(p.e))).map((a) => `${m.id}/${a.name}`.toLowerCase()),
    );
    expect(plan.auditFirst.sort()).toEqual(enforcing.sort());
    expect(phase(plan, 'enforce')).toHaveLength(enforcing.length);
    expect(phase(plan, 'audit').filter((s) => s.kind === 'add')).toHaveLength(d.stats.assignments);
    // Fewest affected resources first.
    const counts = phase(plan, 'enforce').map((s) => s.nonCompliant!);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('counts the non-compliant resources an enforcement would affect, and asks to fix them first', () => {
    const affected = phase(plan, 'enforce').filter((s) => s.nonCompliant);
    expect(affected.length).toBeGreaterThan(0);
    for (const s of affected) {
      const a = d.mgs.find((m) => m.id === s.scope)!.assignments.find((x) => x.name === s.assignment)!;
      expect(a.policies.some((m) => m.p === denyA && ENFORCING_EFFECTS.has(m.e))).toBe(true);
    }
    expect(phase(plan, 'review')).toHaveLength(affected.length);
  });

  it('removes what the design replaces or lacks at its groups, and leaves other scopes alone', () => {
    const cleanup = phase(plan, 'cleanup');
    expect(cleanup.map((s) => s.assignment).sort()).toEqual(['Audit-NIST', 'Enforce-GR-Custom']);
    expect(cleanup.find((s) => s.assignment === 'Audit-NIST')!.detail).toMatch(/^Replaced by /);
    expect(cleanup.find((s) => s.assignment === 'Enforce-GR-Custom')!.command).toBe(
      'az policy assignment delete --name "Enforce-GR-Custom" --scope "/providers/Microsoft.Management/managementGroups/contoso-landingzones"',
    );
    expect(plan.notes.some((n) => n.startsWith('1 assignment is at scopes outside'))).toBe(true);
    expect(scopeResourceId(`subscription:${sub}`)).toBe(`/subscriptions/${sub}`);
  });

  it('adopts assignments that already exist, enforcing the ones in DoNotEnforce', () => {
    // Azure has exactly the design, but nothing enforced.
    const snapshot: PolicySnapshot = { ...designSnapshot(d, 'Tenant'), kind: 'azure' };
    snapshot.assignments = snapshot.assignments.map((a) => ({ ...a, enforcementMode: 'DoNotEnforce' }));
    const p = buildMigrationPlan(d, 'Target', snapshot);
    expect(phase(p, 'groups')).toHaveLength(0);
    expect(phase(p, 'audit')).toHaveLength(0);
    expect(phase(p, 'cleanup')).toHaveLength(0);
    expect(phase(p, 'enforce').every((s) => s.detail === 'In Azure already, in DoNotEnforce.')).toBe(true);
    expect(p.existing.assignments).toHaveLength(d.stats.assignments);
    expect(p.notes.some((n) => n.includes('no compliance state'))).toBe(true);
  });

  it('suggests the tenant\'s prefix when none of the groups match', () => {
    const p = buildMigrationPlan(design({ prefix: 'fabrikam' }), 'Target', tenant);
    expect(p.matchedMgs).toBe(0);
    expect(p.suggestedPrefix).toBe('contoso');
  });

  it('deploys phase 2 with the enforcing assignments in DoNotEnforce, and writes the plan as Markdown', () => {
    const first = auditFirstDesign(d, plan);
    const all = first.mgs.flatMap((m) => m.assignments.map((a) => ({ key: `${m.id}/${a.name}`.toLowerCase(), a })));
    for (const { key, a } of all) if (plan.auditFirst.includes(key)) expect(a.enforcementMode).toBe('DoNotEnforce');
    expect(d.mgs.flatMap((m) => m.assignments).some((a) => a.enforcementMode === 'Default')).toBe(true);
    const md = migrationMarkdown(plan);
    expect(md).toContain('# Migration plan: Tenant → Target');
    expect(md).toContain('## 5. Clean up');
    expect(md).toContain('az policy assignment delete --name "Enforce-GR-Custom"');
  });
});
