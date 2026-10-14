import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import type { Catalog } from './catalog';
import { DEFAULT_INPUT, buildDesign } from './engine';
import { buildReport, reportFileName } from './report';
import { columnName, createXlsx } from './xlsx';

const catalog = catalogJson as unknown as Catalog;
const now = new Date('2026-10-13T12:00:00Z');

describe('compliance report', () => {
  const design = buildDesign(
    catalog,
    {
      ...DEFAULT_INPUT,
      frameworks: ['nist-800-53-r5', 'pci-dss-4'],
      overrides: { 'landingzones/Deny-IP-forwarding': { enforcementMode: 'DoNotEnforce' } },
      exemptions: [
        { id: 'a', mg: 'landingzones', assignment: 'Deny-IP-forwarding', scope: { kind: 'managementGroup', role: 'corp' }, policies: [], category: 'Waiver', reason: 'NVA <hub> & "spokes"', expiresOn: '2026-10-20' },
        { id: 'b', mg: 'landingzones', assignment: 'Deny-IP-forwarding', scope: { kind: 'subscription', id: '1111' }, policies: [], category: 'Mitigated', reason: 'Old', expiresOn: '2026-01-01' },
      ],
    },
    now,
  );
  const sheets = buildReport(catalog, design, now);
  const sheet = (name: string) => sheets.find((s) => s.name === name)!;

  it('has a sheet per area, with every in-scope control', () => {
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Controls', 'Assignments', 'Exemptions', 'Overrides', 'Privileged access']);
    expect(sheet('Controls').rows.length - 1).toBe(design.coverage.reduce((n, c) => n + c.inScope, 0));
    expect(sheet('Assignments').rows.length - 1).toBe(design.stats.assignments);
  });

  it('lists every exemption with its expiry state, including expired ones', () => {
    const rows = sheet('Exemptions').rows.slice(1);
    expect(rows.map((r) => r[7])).toEqual(['Expires in 7 days', 'Expired: no longer applies']);
    expect(rows[0][2]).toBe('Management group: Corp');
    expect(sheet('Summary').rows.find((r) => r[0] === 'Exemptions')![1]).toBe('2 (1 expiring within 30 days, 1 expired)');
  });

  it('reports overrides and the PIM settings', () => {
    expect(sheet('Overrides').rows[1]).toEqual(['Landing zones', 'Deny-IP-forwarding', 'DoNotEnforce', '', '', '']);
    expect(sheet('Privileged access').rows.some((r) => r[0] === 'Longest activation')).toBe(true);
  });

  it('names the file after the design', () => {
    expect(reportFileName({ ...DEFAULT_INPUT, name: 'NIST / Prod!' }, now)).toBe('nist-prod-compliance-report-2026-10-13.xlsx');
  });

  it('writes a workbook with escaped text', () => {
    const bytes = createXlsx(sheets, now);
    const text = new TextDecoder().decode(bytes);
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet6.xml']) expect(text).toContain(part);
    expect(text).toContain('NVA &lt;hub&gt; &amp; &quot;spokes&quot;');
    expect([columnName(0), columnName(25), columnName(26), columnName(701), columnName(702)]).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
  });
});
