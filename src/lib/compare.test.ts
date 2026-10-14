import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import type { Catalog } from './catalog';
import { compareAssignments, compareMgs, comparePolicies, coverageDifferences, overlap, snapshotCoverage } from './compare';
import { DEFAULT_INPUT, buildDesign } from './engine';
import { catalogPolicy, definitionKey, designSnapshot, jsonValues, parseAzureImport, parseCsv } from './snapshot';

const catalog = catalogJson as unknown as Catalog;
const nist = catalog.frameworks.find((f) => f.key === 'nist-800-53-r5')!;
const tenant = '00000000-1111-2222-3333-444444444444';
const sub = '55555555-6666-7777-8888-999999999999';
const mg = (name: string) => `/providers/Microsoft.Management/managementGroups/${name}`;
const builtIn = (guid: string) => `/providers/Microsoft.Authorization/policyDefinitions/${guid}`;

// Two Deny-capable built-ins from the NIST initiative, for a custom initiative.
const [denyA, denyB] = nist.refs.map((r) => r.p).filter((p, i, all) => catalog.policies[p]?.a.includes('Deny') && all.indexOf(p) === i);

/** A Resource Graph export shaped like the import commands' output (fake IDs). */
function fixture(): string {
  const page1 = {
    totalRecords: 6,
    count: 6,
    data: [
      { id: mg('contoso'), name: 'contoso', type: 'microsoft.management/managementgroups', properties: { displayName: 'Contoso', details: { parent: { id: mg(tenant) } } } },
      {
        id: mg('contoso-landingzones'),
        name: 'contoso-landingzones',
        type: 'microsoft.management/managementgroups',
        properties: { displayName: 'Landing zones', details: { parent: { id: mg('contoso') } } },
      },
      {
        id: `${mg('contoso')}/providers/Microsoft.Authorization/policySetDefinitions/Enforce-Guardrails-Custom_20250101`,
        name: 'Enforce-Guardrails-Custom_20250101',
        type: 'microsoft.authorization/policysetdefinitions',
        properties: {
          displayName: 'Custom guardrails',
          policyType: 'Custom',
          parameters: { effect: { type: 'String', defaultValue: 'Audit' } },
          policyDefinitions: [
            { policyDefinitionReferenceId: 'refA', policyDefinitionId: builtIn(denyA), parameters: { effect: { value: "[parameters('effect')]" } } },
            { policyDefinitionReferenceId: 'refB', policyDefinitionId: builtIn(denyB), parameters: { effect: { value: 'Deny' } } },
            { policyDefinitionReferenceId: 'refC', policyDefinitionId: `${mg('contoso')}/providers/Microsoft.Authorization/policyDefinitions/My-Custom-Policy` },
          ],
        },
      },
      {
        id: `${mg('contoso')}/providers/Microsoft.Authorization/policyDefinitions/My-Custom-Policy`,
        name: 'My-Custom-Policy',
        type: 'microsoft.authorization/policydefinitions',
        properties: {
          displayName: 'My custom policy',
          policyType: 'Custom',
          parameters: { effect: { type: 'String', defaultValue: 'AuditIfNotExists' } },
          policyRule: { if: {}, then: { effect: "[parameters('effect')]" } },
        },
      },
      {
        id: `${mg('contoso')}/providers/Microsoft.Authorization/policyAssignments/Audit-NIST`,
        name: 'Audit-NIST',
        type: 'microsoft.authorization/policyassignments',
        properties: { displayName: 'NIST', policyDefinitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${nist.id}`, enforcementMode: 'Default' },
      },
      {
        id: `${mg('contoso-landingzones')}/providers/Microsoft.Authorization/policyAssignments/Enforce-GR-Custom`,
        name: 'Enforce-GR-Custom',
        type: 'microsoft.authorization/policyassignments',
        properties: {
          displayName: 'Custom guardrails',
          policyDefinitionId: `${mg('contoso')}/providers/Microsoft.Authorization/policySetDefinitions/Enforce-Guardrails-Custom_20250101`,
          enforcementMode: 'Default',
          parameters: { effect: { value: 'Deny' } },
          overrides: [{ kind: 'policyEffect', value: 'Disabled', selectors: [{ kind: 'policyDefinitionReferenceId', in: ['refC'] }] }],
        },
      },
    ],
  };
  const page2 = {
    totalRecords: 3,
    count: 3,
    data: [
      {
        id: `/subscriptions/${sub}/providers/Microsoft.Authorization/policyAssignments/Allowed-Locations`,
        name: 'Allowed-Locations',
        type: 'microsoft.authorization/policyassignments',
        properties: {
          displayName: 'Allowed locations',
          policyDefinitionId: builtIn('e56962a6-4747-49cd-b67b-bf8b01975c4c'),
          enforcementMode: 'DoNotEnforce',
          parameters: { listOfAllowedLocations: { value: ['eastus2'] } },
        },
      },
      {
        id: `${mg(tenant)}/providers/Microsoft.Authorization/policyAssignments/sys.mfa-write`,
        name: 'sys.mfa-write',
        type: 'microsoft.authorization/policyassignments',
        properties: { assignmentType: 'SystemHidden', policyDefinitionId: builtIn('54f51f64-eaa5-44cf-8674-830bcfd14d21'), enforcementMode: 'Default' },
      },
      {
        id: `/subscriptions/${sub}/providers/Microsoft.Authorization/policyExemptions/legacy`,
        name: 'legacy',
        type: 'microsoft.authorization/policyexemptions',
        properties: {
          displayName: 'Legacy subscription',
          exemptionCategory: 'Waiver',
          policyAssignmentId: `${mg('contoso-landingzones')}/providers/Microsoft.Authorization/policyAssignments/Enforce-GR-Custom`,
          policyDefinitionReferenceIds: ['refA'],
          expiresOn: '2027-03-31T00:00:00Z',
        },
      },
    ],
  };
  // As the commands write it: pages one after another, with az CLI noise in between.
  return `${JSON.stringify(page1, null, 2)}\nWARNING: some az CLI message\n${JSON.stringify(page2)}\n`;
}

describe('Azure import', () => {
  const s = parseAzureImport(fixture(), catalog, 'Tenant', new Date('2026-10-13T00:00:00Z'));
  const assignment = (name: string) => s.assignments.find((a) => a.name === name)!;

  it('finds every value in pasted pages', () => {
    expect(jsonValues(fixture()).length).toBe(2);
  });

  it('reads management groups and the scopes assignments use', () => {
    expect(s.mgs.map((m) => [m.id, m.parentId])).toEqual([
      ['contoso', tenant],
      ['contoso-landingzones', 'contoso'],
      [`subscription:${sub}`, null],
      [tenant, null],
    ]);
    expect(assignment('Allowed-Locations').scope).toBe(`subscription:${sub}`);
  });

  it('resolves initiative members, effects from parameters and overrides', () => {
    const custom = assignment('Enforce-GR-Custom');
    expect(custom.definitionKey).toBe('enforce-guardrails-custom');
    expect(custom.members).toEqual([
      { p: denyA, e: 'Deny' }, // the set's effect parameter, set to Deny by the assignment
      { p: denyB, e: 'Deny' }, // a literal
      { p: 'my-custom-policy', e: 'Disabled' }, // overridden
    ]);
    expect(assignment('Audit-NIST').members.length).toBe(new Set(nist.refs.map((r) => r.p)).size);
    expect(assignment('Allowed-Locations')).toMatchObject({ enforcementMode: 'DoNotEnforce', members: [{ p: 'e56962a6-4747-49cd-b67b-bf8b01975c4c', e: 'Deny' }] });
    expect(assignment('sys.mfa-write').system).toBe(true);
  });

  it('detects the assigned frameworks and reads exemptions', () => {
    expect(s.frameworks).toEqual(['nist-800-53-r5']);
    expect(s.exemptions).toEqual([
      { assignment: 'Enforce-GR-Custom', scope: `subscription:${sub}`, category: 'Waiver', displayName: 'Legacy subscription', references: ['refA'], expiresOn: '2027-03-31' },
    ]);
  });

  it('rejects text with no Resource Graph rows', () => {
    expect(() => parseAzureImport('nothing here', catalog)).toThrow(/No Azure Resource Graph rows/);
  });

  it('keys ALZ definitions without their version suffix, and finds catalog policies whatever the case', () => {
    expect(definitionKey('/providers/x/policySetDefinitions/Enforce-Guardrails-KeyVault_20260203')).toBe('enforce-guardrails-keyvault');
    expect(catalogPolicy(catalog, 'deny-storage-sftp')).toBe(catalog.policies['Deny-Storage-SFTP']);
  });
});

/** A Resource Graph Explorer CSV download of rows: properties as a JSON cell, every field quoted. */
function toCsv(rows: { id: string; name: string; type: string; properties: unknown }[], options: { bom?: boolean; friendly?: boolean } = {}): string {
  const friendly: Record<string, string> = {
    'microsoft.authorization/policyassignments': 'Policy assignment',
    'microsoft.management/managementgroups': 'Management group',
    'microsoft.authorization/policysetdefinitions': 'Initiative definition',
    'microsoft.authorization/policydefinitions': 'Policy definition',
    'microsoft.authorization/policyexemptions': 'Policy exemption',
  };
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.id, r.name, options.friendly ? friendly[r.type] : r.type, JSON.stringify(r.properties)].map(q).join(','));
  return (options.bom ? '\uFEFF' : '') + ['"id","name","type","properties"', ...lines].join('\r\n') + '\r\n';
}

describe('Resource Graph Explorer CSV import', () => {
  const pages = jsonValues(fixture()) as { data: { id: string; name: string; type: string; properties: unknown }[] }[];

  it('reads the two CSV downloads into the same snapshot as the command output', () => {
    const fromJson = parseAzureImport(fixture(), catalog, 'Tenant', new Date('2026-10-13T00:00:00Z'));
    const fromCsv = parseAzureImport([toCsv(pages[0].data, { bom: true }), toCsv(pages[1].data)], catalog, 'Tenant', new Date('2026-10-13T00:00:00Z'));
    expect(fromCsv).toEqual(fromJson);
  });

  it('maps friendly type names, when "Format results" was left on', () => {
    const snapshot = parseAzureImport(toCsv([...pages[0].data, ...pages[1].data], { friendly: true }), catalog);
    expect(snapshot.assignments.length).toBe(4);
    expect(snapshot.mgs.some((m) => m.id === 'contoso-landingzones')).toBe(true);
  });

  it('parses quoted fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, ""y""","line\nbreak"\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line\nbreak'],
    ]);
  });
});

describe('comparing snapshots', () => {
  const azure = parseAzureImport(fixture(), catalog, 'Tenant');
  const design = designSnapshot(buildDesign(catalog, { ...DEFAULT_INPUT, frameworks: ['nist-800-53-r5'] }), 'Design');

  it('splits policies into only A, both and only B, ignoring system assignments', () => {
    const rows = comparePolicies(design, azure);
    const counts = overlap(rows);
    expect(counts.onlyA + counts.both + counts.onlyB).toBe(rows.length);
    expect(counts.both).toBeGreaterThan(0);
    expect(rows.some((r) => r.p === '54f51f64-eaa5-44cf-8674-830bcfd14d21')).toBe(false);
    expect(comparePolicies(design, azure, { includeSystem: true }).some((r) => r.p === '54f51f64-eaa5-44cf-8674-830bcfd14d21')).toBe(true);
    // Disabled members don't count.
    expect(rows.some((r) => r.p === 'my-custom-policy')).toBe(false);
    // Allowed locations: enforced in the design, DoNotEnforce in Azure.
    const locations = rows.find((r) => r.p === 'e56962a6-4747-49cd-b67b-bf8b01975c4c')!;
    expect(locations).toMatchObject({ side: 'both', enforcementDiffers: true });
    expect(overlap(rows, true).both).toBeLessThan(counts.both);
  });

  it('matches assignments by definition and reports scope and enforcement differences', () => {
    const rows = compareAssignments(design, azure);
    const nistRow = rows.find((r) => r.definitionKey === nist.id.toLowerCase())!;
    expect(nistRow.side).toBe('both');
    expect(nistRow.differences).toEqual([]);
    const locations = rows.find((r) => r.definitionKey === 'e56962a6-4747-49cd-b67b-bf8b01975c4c')!;
    expect(locations.differences).toEqual(['assigned at Contoso vs Subscription 55555555-6666-7777-8888-999999999999', 'enforcement Default vs DoNotEnforce']);
    expect(rows.find((r) => r.definitionKey === 'enforce-guardrails-custom')!.side).toBe('b');
  });

  it('compares management groups by ID', () => {
    const rows = compareMgs(design, azure);
    expect(rows.find((r) => r.id === 'contoso')!.side).toBe('both');
    expect(rows.find((r) => r.id === 'contoso-platform')!.side).toBe('a');
    expect(rows.find((r) => r.id === tenant)!.side).toBe('b');
  });

  it('rates each side against a framework and lists the controls that differ', () => {
    const a = snapshotCoverage(catalog, design, 'nist-800-53-r5', { baseline: 'moderate', privacy: false })!;
    const b = snapshotCoverage(catalog, azure, 'nist-800-53-r5', { baseline: 'moderate', privacy: false })!;
    const total = (c: typeof a) => Object.values(c.counts).reduce((n, x) => n + x, 0);
    expect(total(a)).toBe(total(b));
    expect(a.counts.enforced).toBeGreaterThan(b.counts.enforced);
    expect(b.counts.missing).toBe(0); // the NIST initiative itself is assigned in the tenant
    const diff = coverageDifferences(a, b);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((d) => d.a !== d.b)).toBe(true);
    const empty = parseAzureImport(JSON.stringify({ data: [{ id: mg('x'), name: 'x', type: 'microsoft.management/managementgroups', properties: {} }] }), catalog);
    expect(snapshotCoverage(catalog, empty, 'nist-800-53-r5')!.counts.enforced).toBe(0);
    expect(snapshotCoverage(catalog, empty, 'nist-800-53-r5')!.counts.missing).toBeGreaterThan(0);
  });
});
