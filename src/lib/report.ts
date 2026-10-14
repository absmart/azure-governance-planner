// Compliance report for auditors: the design's control coverage, assignments,
// exemptions, overrides and privileged access, as workbook sheets.

import type { Catalog } from './catalog';
import { exemptionExpiry, type Design, type DesignInput, type ScopeRef } from './engine';
import { pimRoles } from './pim';
import type { Cell, Sheet } from './xlsx';

const STATUS: Record<string, string> = {
  enforced: 'Enforced',
  audited: 'Audited',
  pim: 'PIM',
  manual: 'Manual only',
  excluded: 'Excluded (manual)',
  none: 'No policy',
};

const duration = (iso: string) => (iso.startsWith('PT') ? `${iso.slice(2, -1)} hours` : `${iso.slice(1, -1)} days`);

export function reportFileName(input: DesignInput, now = new Date()): string {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
  return `${slug}-compliance-report-${now.toISOString().slice(0, 10)}.xlsx`;
}

export function buildReport(catalog: Catalog, design: Design, now = new Date()): Sheet[] {
  const input = design.input;
  const mgName = (role: string) => design.mgs.find((m) => m.role === role)?.displayName ?? role;
  const scope = (s: ScopeRef) =>
    s.kind === 'managementGroup' ? `Management group: ${mgName(s.role)}` : s.kind === 'subscription' ? `Subscription: ${s.id}` : `Resource group: ${s.id}`;
  const policyName = (id: string) => catalog.policies[id]?.n ?? id;
  const exemptions = input.exemptions ?? [];
  const expiring = exemptions.filter((e) => exemptionExpiry(e, now).state === 'expiring').length;
  const expired = exemptions.filter((e) => exemptionExpiry(e, now).state === 'expired').length;
  const overrides = Object.entries(input.overrides ?? {});

  const summary: Cell[][] = [
    ['Item', 'Value'],
    ['Design', input.name],
    ['Generated', now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
    ['Cloud', input.cloud === 'AzureUSGovernment' ? 'Azure Government' : 'Azure commercial'],
    ['Enforcement posture', { audit: 'Audit first', alz: 'ALZ defaults', strict: 'Strict' }[input.enforcement]],
    ['Policy data', `${catalog.generated}, ALZ library ${catalog.alz.ref}`],
    ['Management groups', design.stats.managementGroups],
    ['Policy assignments', design.stats.assignments],
    ['Enforcing assignments', design.stats.enforcingAssignments],
    ['Overrides', overrides.length],
    ['Exemptions', `${exemptions.length} (${expiring} expiring within 30 days, ${expired} expired)`],
    ['Manual-only controls', input.excludeManualControls ? 'Excluded from evaluation' : 'Included'],
    ['Privileged Identity Management', design.pim ? `${design.pim.profile === 'high' ? 'High' : 'Standard'} profile (${design.pim.reason})` : 'Off'],
    [],
    ['Framework', 'In scope', 'Enforced', 'Audited', 'PIM', 'Manual only', 'Excluded (manual)', 'No policy', 'Partly applied', 'Outside baseline'],
    ...design.coverage.map((c) => [
      c.name,
      c.inScope,
      c.counts.enforced,
      c.counts.audited,
      c.counts.pim,
      c.counts.manual,
      c.counts.excluded,
      c.counts.none,
      c.partial,
      c.outOfBaseline,
    ]),
  ];

  const controls: Cell[][] = [
    ['Framework', 'Family', 'Control', 'Title', 'Status', 'Partly applied', 'Exceptions', 'Automated policies', 'Manual policies', 'Enforced by', 'Addressed by PIM'],
    ...design.coverage.flatMap((c) =>
      c.families.flatMap((f) =>
        f.controls.map((x) => [
          c.short,
          `${f.code} ${f.title}`.trim(),
          x.id,
          x.title ?? '',
          STATUS[x.status],
          x.exceptions.length ? 'Yes' : '',
          x.exceptions.join('; '),
          x.automated.length,
          x.manual,
          x.enforcedBy.join(', '),
          x.pim ? 'Yes' : '',
        ]),
      ),
    ),
  ];

  const assignments: Cell[][] = [
    ['Management group', 'Assignment', 'Display name', 'Origin', 'Definition', 'Source', 'Enforcement mode', 'Policies', 'Change from default', 'Excluded scopes', 'Exemptions'],
    ...design.mgs.flatMap((m) =>
      m.assignments.map((a) => [
        m.displayName,
        a.name,
        a.displayName,
        a.origin,
        a.definitionName,
        a.definitionSource,
        a.enforcementMode,
        a.policies.length,
        a.change ?? '',
        (a.notScopes ?? []).map(scope).join('; '),
        a.exemptions.length || '',
      ]),
    ),
  ];

  const exemptionRows: Cell[][] = [
    ['Assignment', 'Assigned at', 'Exempted at', 'Policies', 'Category', 'Reason', 'Expires', 'Status'],
    ...exemptions.map((e) => {
      const { state, days } = exemptionExpiry(e, now);
      return [
        e.assignment,
        mgName(e.mg),
        scope(e.scope),
        e.policies.length ? e.policies.map(policyName).join('; ') : 'Whole assignment',
        e.category,
        e.reason,
        e.expiresOn ?? 'No expiry',
        state === 'expired' ? 'Expired: no longer applies' : state === 'expiring' ? `Expires in ${days} days` : 'Active',
      ];
    }),
  ];

  const overrideRows: Cell[][] = [
    ['Management group', 'Assignment', 'Enforcement mode', 'Removed', 'Excluded scopes', 'Parameters'],
    ...overrides.map(([key, o]) => {
      const [role, name] = key.split('/');
      return [
        mgName(role),
        name,
        o.enforcementMode ?? 'As designed',
        o.disabled ? 'Yes' : '',
        (o.notScopes ?? []).map(scope).join('; '),
        o.parameters ? JSON.stringify(o.parameters) : '',
      ];
    }),
  ];

  const pim = design.pim;
  const roles = pimRoles(design.customRoles);
  const pimRows: Cell[][] = pim
    ? [
        ['Setting', 'Value'],
        ['Profile', `${pim.profile === 'high' ? 'High' : 'Standard'}: ${pim.reason}`],
        ['Longest activation', duration(pim.settings.activationMaximumDuration)],
        ['Activation requires', ['MFA', pim.settings.requireJustification && 'justification', pim.settings.requireTicket && 'ticket number'].filter(Boolean).join(', ')],
        ['Eligible assignments expire after', duration(pim.settings.eligibleExpireAfter)],
        ['Active assignments expire after', `${duration(pim.settings.activeExpireAfter)} (no permanent assignments)`],
        ['Access reviews (Entra ID)', pim.settings.accessReview],
        [],
        ['Role under PIM', 'Approval required'],
        ...pim.roles.map((r) => [r.name, r.requireApproval ? 'Yes' : 'No']),
        [],
        ['Eligible group', 'Role', 'At'],
        ...pim.eligibilities.map((e) => [e.label, roles.find((r) => r.key === e.role)?.name ?? e.role, mgName(e.mg)]),
        [],
        ['Framework', 'Control', 'How PIM helps'],
        ...pim.controls.flatMap((c) => c.controls.map((x) => [c.framework, x.id, x.text])),
      ]
    : [['Setting', 'Value'], ['Privileged Identity Management', 'Off']];

  return [
    { name: 'Summary', rows: summary, widths: [32, 60, 10, 10, 8, 12, 18, 10, 14, 16] },
    { name: 'Controls', rows: controls },
    { name: 'Assignments', rows: assignments },
    { name: 'Exemptions', rows: exemptionRows },
    { name: 'Overrides', rows: overrideRows },
    { name: 'Privileged access', rows: pimRows, widths: [36, 40, 80] },
  ];
}
