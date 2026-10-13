import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_SETTINGS,
  backupFileName,
  createDesign,
  duplicateDesign,
  hasUnsavedChanges,
  parseBackup,
  renameDesign,
  toBackup,
  updateDesign,
} from './designs';
import { DEFAULT_INPUT, type DesignInput } from './engine';

const now = new Date('2026-10-13T12:00:00Z');

const withChanges = (): DesignInput => ({
  ...DEFAULT_INPUT,
  frameworks: ['nist-800-53-r5', 'pci-dss-4'],
  overrides: { 'landingzones/Deny-IP-forwarding': { enforcementMode: 'DoNotEnforce' } },
  exemptions: [
    {
      id: 'e1',
      mg: 'landingzones',
      assignment: 'Deny-IP-forwarding',
      scope: { kind: 'subscription', id: '11111111-2222-3333-4444-555555555555' },
      policies: [],
      category: 'Waiver',
      reason: 'NVA',
    },
  ],
});

describe('saved designs', () => {
  it('saves a copy of the decisions and export settings that later edits do not change', () => {
    const input = withChanges();
    const settings = { ...DEFAULT_EXPORT_SETTINGS, values: { platform_subscription_id: 'abc' } };
    const design = createDesign(input, settings, now);
    expect(design.name).toBe('Contoso governance');
    expect(design.savedAt).toBe('2026-10-13T12:00:00.000Z');
    expect(hasUnsavedChanges(design, input, settings)).toBe(false);

    input.frameworks.push('soc2');
    expect(design.input.frameworks).toEqual(['nist-800-53-r5', 'pci-dss-4']);
    expect(hasUnsavedChanges(design, input, settings)).toBe(true);

    const updated = updateDesign(design, input, { ...settings, environment: 'dev' });
    expect(updated.id).toBe(design.id);
    expect(updated.exportSettings.environment).toBe('dev');
    expect(hasUnsavedChanges(updated, input, { ...settings, environment: 'dev' })).toBe(false);
    expect(hasUnsavedChanges(updated, input, settings)).toBe(true);
    expect(hasUnsavedChanges(undefined, input, settings)).toBe(true);
  });

  it('ignores key order when checking for unsaved changes', () => {
    const input = withChanges();
    const design = createDesign(input, DEFAULT_EXPORT_SETTINGS, now);
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as DesignInput;
    expect(hasUnsavedChanges(design, reordered, { values: {}, environment: 'prd', format: 'bicep' })).toBe(false);
  });

  it('renames and duplicates without name clashes', () => {
    const a = renameDesign(createDesign(DEFAULT_INPUT, DEFAULT_EXPORT_SETTINGS), 'FedRAMP High');
    expect(a.input.name).toBe('FedRAMP High');
    const b = duplicateDesign(a, [a]);
    const c = duplicateDesign(a, [a, b]);
    expect([b.name, c.name]).toEqual(['FedRAMP High (copy)', 'FedRAMP High (copy 2)']);
    expect(b.input.name).toBe('FedRAMP High (copy)');
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('round-trips a backup file with fresh ids, keeping overrides and exemptions', () => {
    const designs = [
      createDesign(withChanges(), DEFAULT_EXPORT_SETTINGS),
      createDesign({ ...DEFAULT_INPUT, name: 'Gov', cloud: 'AzureUSGovernment' }, { ...DEFAULT_EXPORT_SETTINGS, format: 'terraform' }),
    ];
    const imported = parseBackup(JSON.stringify(toBackup(designs, now)));
    expect(imported.map((d) => d.name)).toEqual(['Contoso governance', 'Gov']);
    expect(imported[0].input).toEqual(designs[0].input);
    expect(imported[0].input.exemptions[0].reason).toBe('NVA');
    expect(imported[1].exportSettings.format).toBe('terraform');
    expect(imported.some((d) => designs.some((o) => o.id === d.id))).toBe(false);
    expect(backupFileName(designs, now)).toBe('governance-designs-2026-10-13.json');
    expect(backupFileName([renameDesign(designs[0], 'NIST / Prod!')], now)).toBe('governance-design-nist-prod-2026-10-13.json');
  });

  it('fills in decisions added since a design was saved', () => {
    const old = { name: 'Old', input: { frameworks: ['mcsb'], enforcement: 'audit' } };
    const [design] = parseBackup(JSON.stringify(old));
    expect(design.input.frameworks).toEqual(['mcsb']);
    expect(design.input.enforcement).toBe('audit');
    expect(design.input.overrides).toEqual({});
    expect(design.input.privateDnsZones).toEqual(DEFAULT_INPUT.privateDnsZones);
    expect(design.input.name).toBe('Old');
    expect(design.exportSettings).toEqual(DEFAULT_EXPORT_SETTINGS);
  });

  it('rejects files that are not designs', () => {
    expect(() => parseBackup('not json')).toThrow(/not valid JSON/);
    expect(() => parseBackup('{"hello":1}')).toThrow(/doesn't contain decisions/);
    expect(() => parseBackup(JSON.stringify({ app: 'azure-governance-planner', version: 1, designs: [] }))).toThrow(/no designs/);
  });
});
