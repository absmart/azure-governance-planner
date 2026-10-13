import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import type { Catalog } from './catalog';
import {
  assignmentName,
  buildDesign,
  DEFAULT_INPUT,
  effectiveAssignments,
  inNistBaseline,
  type DesignInput,
} from './engine';
import { familyOf } from './families';

const catalog = catalogJson as unknown as Catalog;
const design = (overrides: Partial<DesignInput> = {}) => buildDesign(catalog, { ...DEFAULT_INPUT, ...overrides });
const find = (d: ReturnType<typeof design>, name: string) =>
  d.mgs.flatMap((m) => m.assignments.map((a) => ({ mg: m.role, a }))).find((x) => x.a.name === name);

describe('catalog', () => {
  it('includes NIST SP 800-53 Rev. 5 with control mappings that resolve to OSCAL controls', () => {
    const nist = catalog.frameworks.find((f) => f.key === 'nist-800-53-r5')!;
    expect(nist.id).toBe('179d1daa-458f-4e47-8086-2a68d0d6c38f');
    expect(nist.refs.length).toBeGreaterThan(500);
    const mapped = new Set(nist.refs.flatMap((r) => r.g));
    for (const c of mapped) expect(catalog.nist.controls[c], c).toBeDefined();
  });

  it('knows every policy the frameworks and ALZ assignments reference', () => {
    for (const f of catalog.frameworks) for (const r of f.refs) expect(catalog.policies[r.p], `${f.key} ${r.p}`).toBeDefined();
    for (const [name, a] of Object.entries(catalog.alz.assignments))
      for (const m of a.policies) expect(catalog.policies[m.p], `${name} ${m.p}`).toBeDefined();
  });

  it('has the SP 800-53B baselines nested (Low within Moderate within High)', () => {
    const low = Object.entries(catalog.nist.controls).filter(([, c]) => c.b.includes('L'));
    expect(low.length).toBeGreaterThan(100);
    for (const [id, c] of low) expect(c.b, id).toContain('M');
  });
});

describe('management groups', () => {
  it('follows the ALZ hierarchy by default with the chosen prefix', () => {
    const d = design({ prefix: 'Fabrikam Corp' });
    expect(d.mgs.map((m) => m.id)).toEqual([
      'fabrikam-corp',
      'fabrikam-corp-platform',
      'fabrikam-corp-connectivity',
      'fabrikam-corp-identity',
      'fabrikam-corp-management',
      'fabrikam-corp-security',
      'fabrikam-corp-landingzones',
      'fabrikam-corp-corp',
      'fabrikam-corp-online',
      'fabrikam-corp-parkinglot',
      'fabrikam-corp-sandbox',
      'fabrikam-corp-decommissioned',
    ]);
    expect(d.mgs.find((m) => m.role === 'corp')!.parent).toBe('landingzones');
  });

  it('collapses the platform children when a single platform group is chosen', () => {
    const d = design({ platform: 'single', ddos: true });
    expect(d.mgs.map((m) => m.role)).not.toContain('connectivity');
    expect(find(d, 'Enable-DDoS-VNET')!.mg).toBe('platform');
    // Identity's Deny-Public-IP would block hub firewalls.
    expect(find(d, 'Deny-Public-IP')).toBeUndefined();
  });

  it('adds confidential landing zones with the sovereignty confidential initiative', () => {
    const d = design({ confidential: true });
    const conf = d.mgs.find((m) => m.role === 'confidential-corp')!;
    expect(conf.parent).toBe('landingzones');
    expect(conf.assignments.map((a) => a.name)).toContain('Enforce-Sovereign-Conf');
    // Inherits the corp archetype too.
    expect(conf.assignments.map((a) => a.name)).toContain('Deny-Public-IP-On-NIC');
  });
});

describe('assignments', () => {
  it('assigns the selected framework initiative at the intermediate root, audit only', () => {
    const d = design();
    const nist = find(d, 'Audit-NIST-800-53-R5')!;
    expect(nist.mg).toBe('root');
    expect(nist.a.definitionId).toBe('/providers/Microsoft.Authorization/policySetDefinitions/179d1daa-458f-4e47-8086-2a68d0d6c38f');
    expect(nist.a.policies.some((m) => m.e === 'Manual')).toBe(true);
  });

  it('honours a framework scope override', () => {
    const d = design({ frameworks: ['pci-dss-4'], frameworkScopes: { 'pci-dss-4': 'corp' } });
    expect(find(d, 'Audit-PCI-DSS-4-0-1')!.mg).toBe('corp');
  });

  it("reuses ALZ's MCSB assignment instead of assigning MCSB twice", () => {
    const d = design({ frameworks: ['mcsb'] });
    const mcsb = find(d, 'Deploy-ASC-Monitoring')!;
    expect(mcsb.a.frameworkKey).toBe('mcsb');
    expect(d.mgs.flatMap((m) => m.assignments).filter((a) => a.frameworkKey === 'mcsb')).toHaveLength(1);
  });

  it('keeps every assignment name within 24 characters', () => {
    const d = design({
      frameworks: catalog.frameworks.map((f) => f.key),
      confidential: true,
      sovereignty: true,
      requiredTags: ['ApplicationOwnerEmailAddress'],
    });
    for (const a of d.mgs.flatMap((m) => m.assignments)) expect(a.name.length, a.name).toBeLessThanOrEqual(24);
    expect(d.notes.filter((n) => n.level === 'warning')).toEqual([]);
  });

  it('truncates names cleanly', () => {
    expect(assignmentName('Audit-HIPAA/HITRUST')).toBe('Audit-HIPAA-HITRUST');
    expect(assignmentName('Require-Tag-ApplicationOwnerEmail')).toBe('Require-Tag-ApplicationO');
  });

  it('drops ALZ assignments for decisions that are turned off', () => {
    const d = design({ defender: false, monitoring: false, backup: false, ddos: false, privateCorp: false });
    for (const name of ['Deploy-MDFC-Config-H224', 'Deploy-Diag-LogsCat', 'Deploy-VM-Backup', 'Enable-DDoS-VNET', 'Deny-Public-Endpoints'])
      expect(find(d, name), name).toBeUndefined();
    expect(d.notes.some((n) => n.text.includes('Defender for Cloud is turned off'))).toBe(true);
  });

  it('adds location and tag assignments from decisions', () => {
    const d = design({ allowedLocations: ['eastus2'], requiredTags: ['Owner'] });
    expect(find(d, 'Enforce-Allowed-Locs')!.a.parameters).toEqual({ listOfAllowedLocations: ['eastus2'] });
    expect(find(d, 'Require-Tag-Owner')!.mg).toBe('landingzones');
    expect(find(d, 'Inherit-Tag-Owner')!.a.identity).toBe(true);
  });

  it('uses the sovereignty baseline instead of separate location policies', () => {
    const d = design({ sovereignty: true });
    expect(find(d, 'Enforce-Sovereign-Global')).toBeDefined();
    expect(find(d, 'Enforce-Allowed-Locs')).toBeUndefined();
  });
});

describe('enforcement posture', () => {
  it('audit-first puts Deny assignments in DoNotEnforce and adds no framework enforcement', () => {
    const d = design({ enforcement: 'audit' });
    expect(find(d, 'Deny-Public-IP')!.a.enforcementMode).toBe('DoNotEnforce');
    expect(find(d, 'Deploy-MDFC-Config-H224')!.a.enforcementMode).toBe('Default');
    expect(find(d, 'Enforce-Framework-GR')).toBeUndefined();
  });

  it('ALZ defaults keep the service guardrails in DoNotEnforce and add a what-if framework initiative', () => {
    const d = design({ enforcement: 'alz' });
    expect(find(d, 'Enforce-GR-Storage0')!.a.enforcementMode).toBe('DoNotEnforce');
    const fw = find(d, 'Enforce-Framework-GR')!;
    expect(fw.mg).toBe('landingzones');
    expect(fw.a.enforcementMode).toBe('DoNotEnforce');
    expect(fw.a.policies.length).toBeGreaterThan(0);
    expect(fw.a.policies.every((m) => m.e === 'Deny')).toBe(true);
  });

  it('strict enforces everything', () => {
    const d = design({ enforcement: 'strict' });
    expect(find(d, 'Enforce-GR-Storage0')!.a.enforcementMode).toBe('Default');
    expect(find(d, 'Enforce-Framework-GR')!.a.enforcementMode).toBe('Default');
    // CMK stays a separate decision.
    expect(find(d, 'Enforce-Encrypt-CMK0')!.a.enforcementMode).toBe('DoNotEnforce');
    expect(find(design({ cmk: true }), 'Enforce-Encrypt-CMK0')!.a.enforcementMode).toBe('Default');
  });

  it("doesn't put policies ALZ already denies into the framework initiative", () => {
    const d = design({ enforcement: 'strict' });
    const fw = new Set(find(d, 'Enforce-Framework-GR')!.a.policies.map((m) => m.p));
    for (const { assignment } of effectiveAssignments(d, 'landingzones')) {
      if (assignment.name === 'Enforce-Framework-GR' || assignment.enforcementMode !== 'Default') continue;
      for (const m of assignment.policies) if (m.e === 'Deny') expect(fw.has(m.p), `${assignment.name} ${m.p}`).toBe(false);
    }
  });
});

describe('coverage', () => {
  it('filters NIST controls to the selected baseline', () => {
    const low = design({ nistBaseline: 'low' }).coverage[0];
    const high = design({ nistBaseline: 'high' }).coverage[0];
    const all = design({ nistBaseline: 'all' }).coverage[0];
    expect(low.inScope).toBeLessThan(high.inScope);
    expect(high.inScope).toBeLessThan(all.inScope);
    expect(all.outOfBaseline).toBe(0);
    for (const fam of low.families) for (const c of fam.controls) expect(inNistBaseline(catalog, c.id, 'low', false)).toBe(true);
  });

  it('counts more controls as enforced under strict than audit-first', () => {
    const audit = design({ enforcement: 'audit' }).coverage[0];
    const strict = design({ enforcement: 'strict' }).coverage[0];
    expect(strict.counts.enforced).toBeGreaterThan(audit.counts.enforced);
    const sum = (c: typeof audit) => Object.values(c.counts).reduce((a, b) => a + b, 0);
    expect(sum(audit)).toBe(audit.inScope);
  });

  it('groups NIST controls into families with titles', () => {
    const cov = design().coverage[0];
    const ac = cov.families.find((f) => f.code === 'AC')!;
    expect(ac.title).toBe('Access Control');
    expect(ac.controls.find((c) => c.id === 'AC-2')!.title).toBe('Account Management');
  });

  it('marks controls with only manual attestations as manual', () => {
    const cov = design({ nistBaseline: 'all' }).coverage[0];
    const manual = cov.families.flatMap((f) => f.controls).filter((c) => c.status === 'manual');
    expect(manual.length).toBeGreaterThan(0);
    for (const c of manual) expect(c.automated).toEqual([]);
  });

  it('lists policy rows with frameworks and placements', () => {
    const d = design({ frameworks: ['nist-800-53-r5', 'fedramp-high'] });
    const shared = d.policies.find((r) => r.frameworks.length === 2)!;
    expect(shared).toBeDefined();
    expect(shared.placements.length).toBeGreaterThan(0);
    expect(d.notes.some((n) => n.text.includes('share'))).toBe(true);
  });
});

describe('families', () => {
  it('derives families for each framework style', () => {
    const fam = catalog.nist.families;
    expect(familyOf('cmmc-2-l2', 'AC.L2-3.1.3', fam).title).toBe('Access Control');
    expect(familyOf('nist-800-171-r2', '3.13.8', fam).title).toBe('System and Communications Protection');
    expect(familyOf('pci-dss-4', '10.2.1', fam).code).toBe('10');
    expect(familyOf('soc2', 'CC6.1', fam).code).toBe('CC');
    expect(familyOf('hipaa-hitrust', 'hipaa-0101.00a1Organizational.123-00.a', fam).code).toBe('00');
  });
});

describe('defaults', () => {
  it('adds the Local landing zone only when asked, with the ALZ Azure Local assignment', () => {
    expect(design({}).mgs.map((m) => m.role)).not.toContain('local');
    const d = design({ local: true });
    const local = d.mgs.find((m) => m.role === 'local')!;
    expect(local.parent).toBe('landingzones');
    expect(local.id).toBe('contoso-local');
    expect(local.assignments.map((a) => a.name)).toEqual(['Enforce-ALDO-Services']);
    expect(local.assignments[0].policies.length).toBeGreaterThan(0);
  });

  it('leaves DDoS Network Protection off, for its cost', () => {
    const d = design({});
    expect(find(d, 'Enable-DDoS-VNET')).toBeUndefined();
    expect(d.notes.some((n) => n.text.includes('DDoS Network Protection is turned off'))).toBe(true);
  });
});

describe('Azure Government', () => {
  const gov = design({ cloud: 'AzureUSGovernment', allowedLocations: ['usgovvirginia'], frameworks: ['nist-800-53-r5', 'pci-dss-4'] });

  it('leaves out ALZ assignments and frameworks Azure Government does not have', () => {
    const names = gov.mgs.flatMap((m) => m.assignments.map((a) => a.name));
    expect(names).not.toContain('Deploy-VM-Backup');
    expect(names).toContain('Audit-NIST-800-53-R5');
    expect(names.some((n) => n.startsWith('Audit-PCI'))).toBe(false);
    expect(gov.notes.some((n) => n.text.includes('Not available in Azure Government'))).toBe(true);
  });

  it('leaves Government-missing built-ins out of assignments and coverage', () => {
    for (const a of gov.mgs.flatMap((m) => m.assignments))
      for (const m of a.policies) expect(catalog.policies[m.p]?.ng, `${a.name} ${m.p}`).toBeFalsy();
    const commercial = design({ frameworks: ['nist-800-53-r5'] }).coverage[0];
    expect(gov.coverage[0].automatedPolicies).toBeLessThanOrEqual(commercial.automatedPolicies);
  });

  it('warns about commercial regions', () => {
    expect(design({ cloud: 'AzureUSGovernment' }).notes.some((n) => n.text.startsWith('Not Azure Government regions'))).toBe(true);
    expect(gov.notes.some((n) => n.text.startsWith('Not Azure Government regions'))).toBe(false);
  });
});

describe('overrides and exemptions', () => {
  it('changes enforcement, removes, excludes scopes and sets parameters', () => {
    const d = design({
      overrides: {
        'landingzones/Deny-IP-forwarding': { enforcementMode: 'DoNotEnforce' },
        'root/Deny-Classic-Resources': { disabled: true },
        'landingzones/Deny-MgmtPorts-Internet': {
          notScopes: [
            { kind: 'managementGroup', role: 'online' },
            { kind: 'managementGroup', role: 'platform' },
            { kind: 'subscription', id: '1111' },
          ],
        },
        'root/Audit-ZoneResiliency': { parameters: { effect: 'Disabled' } },
      },
    });
    const at = (role: string, name: string) => d.mgs.find((m) => m.role === role)!.assignments.find((a) => a.name === name);
    expect(at('landingzones', 'Deny-IP-forwarding')!.enforcementMode).toBe('DoNotEnforce');
    expect(at('landingzones', 'Deny-IP-forwarding')!.overridden).toBe(true);
    expect(at('root', 'Deny-Classic-Resources')).toBeUndefined();
    expect(d.mgs.find((m) => m.role === 'root')!.removed).toEqual(['Deny-Classic-Resources']);
    // Platform isn't under Landing zones, so only Online and the subscription stay.
    expect(at('landingzones', 'Deny-MgmtPorts-Internet')!.notScopes).toEqual([
      { kind: 'managementGroup', role: 'online' },
      { kind: 'subscription', id: '1111' },
    ]);
    expect(at('root', 'Audit-ZoneResiliency')!.parameters).toEqual({ effect: 'Disabled' });
  });

  it('attaches exemptions inside the assignment scope and warns about the rest', () => {
    const base = { category: 'Waiver' as const, policies: [], reason: 'legacy' };
    const d = design({
      exemptions: [
        { ...base, id: 'a', mg: 'landingzones', assignment: 'Deny-IP-forwarding', scope: { kind: 'managementGroup', role: 'corp' } },
        { ...base, id: 'b', mg: 'landingzones', assignment: 'Deny-IP-forwarding', scope: { kind: 'managementGroup', role: 'platform' } },
        { ...base, id: 'c', mg: 'root', assignment: 'Not-There', scope: { kind: 'subscription', id: '1' } },
      ],
    });
    const a = d.mgs.find((m) => m.role === 'landingzones')!.assignments.find((x) => x.name === 'Deny-IP-forwarding')!;
    expect(a.exemptions.map((e) => e.id)).toEqual(['a']);
    expect(d.notes.filter((n) => n.level === 'warning' && n.text.startsWith('Exemption')).length).toBe(2);
  });
});

describe('parking lot', () => {
  it('is on by default, and can be turned off', () => {
    expect(design({}).mgs.map((m) => m.role)).toContain('parkinglot');
    expect(design({ parkingLot: false }).mgs.map((m) => m.role)).not.toContain('parkinglot');
  });

  it('adds a Parking lot group under the root with the chosen guardrails', () => {
    const sandbox = design({ parkingLot: true }).mgs.find((m) => m.role === 'parkinglot')!;
    expect(sandbox.parent).toBe('root');
    expect(sandbox.id).toBe('contoso-parkinglot');
    expect(sandbox.assignments.map((a) => a.name)).toEqual(['Enforce-ALZ-Sandbox']);

    const locked = design({ parkingLot: true, parkingLotGuardrails: 'locked' }).mgs.find((m) => m.role === 'parkinglot')!;
    expect(locked.assignments.map((a) => a.name)).toEqual(['Deny-Parking-Resources']);
    expect(locked.assignments[0].parameters).toEqual({ listOfResourceTypesAllowed: [], effect: 'Deny' });

    const inherit = design({ parkingLot: true, parkingLotGuardrails: 'inherit' }).mgs.find((m) => m.role === 'parkinglot')!;
    expect(inherit.assignments).toEqual([]);
  });
});

describe('Privileged Identity Management', () => {
  it('is on by default with the standard profile, and picks the high profile for high-impact frameworks', () => {
    const standard = design({ frameworks: ['nist-800-53-r5'] }).pim!;
    expect(standard.profile).toBe('standard');
    expect(standard.settings.activationMaximumDuration).toBe('PT8H');
    expect(standard.roles.find((r) => r.key === 'contributor')!.requireApproval).toBe(false);
    expect(standard.roles.find((r) => r.key === 'owner')!.requireApproval).toBe(true);
    for (const frameworks of [['fedramp-high'], ['cmmc-2-l2'], ['cjis']]) expect(design({ frameworks }).pim!.profile).toBe('high');
    expect(design({ frameworks: ['nist-800-53-r5'], nistBaseline: 'high' }).pim!.profile).toBe('high');
    const high = design({ frameworks: ['fedramp-high'] }).pim!;
    expect(high.settings).toMatchObject({ activationMaximumDuration: 'PT4H', requireTicket: true, eligibleExpireAfter: 'P180D' });
    expect(high.roles.every((r) => r.requireApproval)).toBe(true);
  });

  it('honours a chosen profile, the roles chosen and eligible groups in the hierarchy', () => {
    const p = design({
      frameworks: ['fedramp-high'],
      pim: {
        enabled: true,
        profile: 'standard',
        roles: ['owner'],
        eligibilities: [
          { id: 'a', label: 'Owners', role: 'owner', mg: 'root' },
          { id: 'b', label: 'Contributors', role: 'contributor', mg: 'landingzones' },
          { id: 'c', label: 'Local owners', role: 'owner', mg: 'local' },
        ],
      },
    }).pim!;
    expect(p.profile).toBe('standard');
    expect(p.roles.map((r) => r.key)).toEqual(['owner']);
    // Contributor isn't under PIM and Local isn't in the design.
    expect(p.eligibilities.map((x) => x.id)).toEqual(['a']);
    expect(p.controls.map((c) => c.framework)).toEqual(['FedRAMP High']);
  });

  it('can be turned off', () => {
    expect(design({ pim: { enabled: false, profile: 'auto', roles: [], eligibilities: [] } }).pim).toBeNull();
  });
});
