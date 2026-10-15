import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import type { Catalog, PolicyInfo } from './catalog';
import {
  assignmentName,
  buildDesign,
  DEFAULT_INPUT,
  DEFAULT_DEFENDER_PLANS,
  DEFENDER_PLANS,
  effectiveAssignments,
  exemptionExpiry,
  inNistBaseline,
  knownInitiatives,
  withCustomPolicies,
  type CustomAssignment,
  type DesignInput,
} from './engine';
import { familyOf } from './families';
import { initiativeMembers, type InitiativeIndex, type PolicyIndex } from './policyIndex';

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

describe('Defender plans', () => {
  const mdfc = (input: Partial<DesignInput> = {}) => find(design(input), 'Deploy-MDFC-Config-H224')!.a;
  const effectOf = (a: ReturnType<typeof mdfc>, param: string) => [...new Set(a.policies.filter((m) => m.ep === param).map((m) => m.e))];

  it('knows which initiative parameter drives each plan', () => {
    const members = catalog.alz.assignments['Deploy-MDFC-Config-H224'].policies;
    for (const p of DEFENDER_PLANS) expect(members.some((m) => m.ep === `enableAscFor${p.key}`), p.key).toBe(true);
  });

  it('turns on the default plans, which ALZ ships Disabled, and leaves CSPM and AI off', () => {
    const a = mdfc();
    expect(DEFAULT_DEFENDER_PLANS).not.toContain('Cspm');
    expect(a.parameters).toMatchObject({ enableAscForServers: 'DeployIfNotExists', enableAscForCspm: 'Disabled', enableAscForAI: 'Disabled' });
    expect(effectOf(a, 'enableAscForServers')).toEqual(['DeployIfNotExists']);
    expect(effectOf(a, 'enableAscForContainers')).toEqual(['DeployIfNotExists']);
    expect(effectOf(a, 'enableAscForCspm')).toEqual(['Disabled']);
    expect(a.change).toMatch(/Enables Defender plans: Servers/);
  });

  it('follows the picked plans, and overrides of the plan parameters', () => {
    const a = mdfc({ defenderPlans: ['Cspm'] });
    expect(effectOf(a, 'enableAscForCspm')).toEqual(['DeployIfNotExists']);
    expect(effectOf(a, 'enableAscForServers')).toEqual(['Disabled']);
    expect(mdfc({ defenderPlans: [] }).change).toMatch(/No Defender plans/);
    const o = mdfc({ overrides: { 'root/Deploy-MDFC-Config-H224': { parameters: { enableAscForSql: 'Disabled' } } } });
    expect(effectOf(o, 'enableAscForSql')).toEqual(['Disabled']);
    expect(effectOf(o, 'enableAscForStorage')).toEqual(['DeployIfNotExists']);
    // The catalog's members are left as they were.
    expect(catalog.alz.assignments['Deploy-MDFC-Config-H224'].policies.find((m) => m.ep === 'enableAscForSql')!.e).toBe('Disabled');
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
    // Locked by default: a custom deny-everything policy, enforced even in the audit-first posture.
    const locked = design({ enforcement: 'audit' }).mgs.find((m) => m.role === 'parkinglot')!;
    expect(locked.parent).toBe('root');
    expect(locked.id).toBe('contoso-parkinglot');
    expect(locked.assignments.map((a) => a.name)).toEqual(['Deny-Parking-Resources']);
    expect(locked.assignments[0]).toMatchObject({
      definitionSource: 'Custom',
      enforcementMode: 'Default',
      definitionId: '/providers/Microsoft.Management/managementGroups/contoso/providers/Microsoft.Authorization/policyDefinitions/Deny-ParkingLot-Resources',
    });

    const sandbox = design({ parkingLotGuardrails: 'sandbox' }).mgs.find((m) => m.role === 'parkinglot')!;
    expect(sandbox.assignments.map((a) => a.name)).toEqual(['Enforce-ALZ-Sandbox']);

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

describe('exemption expiry', () => {
  const now = new Date('2026-10-13T15:00:00Z');
  const exemption = (id: string, expiresOn?: string) => ({
    id,
    mg: 'landingzones' as const,
    assignment: 'Deny-IP-forwarding',
    scope: { kind: 'managementGroup' as const, role: 'corp' as const },
    policies: [],
    category: 'Waiver' as const,
    reason: id,
    ...(expiresOn ? { expiresOn } : {}),
  });

  it('tells active, expiring and expired exemptions apart', () => {
    expect(exemptionExpiry(exemption('a'), now)).toEqual({ state: 'active', days: null });
    expect(exemptionExpiry(exemption('a', '2026-12-31'), now).state).toBe('active');
    expect(exemptionExpiry(exemption('a', '2026-11-12'), now)).toEqual({ state: 'expiring', days: 30 });
    expect(exemptionExpiry(exemption('a', '2026-10-14'), now)).toEqual({ state: 'expiring', days: 1 });
    expect(exemptionExpiry(exemption('a', '2026-10-13'), now).state).toBe('expired');
    expect(exemptionExpiry(exemption('a', '2026-01-01'), now).state).toBe('expired');
  });

  it('warns about expiring ones and leaves expired ones out', () => {
    const d = buildDesign(
      catalog,
      { ...DEFAULT_INPUT, exemptions: [exemption('soon', '2026-10-20'), exemption('gone', '2026-09-30'), exemption('fine', '2027-06-30')] },
      now,
    );
    const a = d.mgs.find((m) => m.role === 'landingzones')!.assignments.find((x) => x.name === 'Deny-IP-forwarding')!;
    expect(a.exemptions.map((e) => e.id)).toEqual(['soon', 'fine']);
    expect(d.notes.some((n) => n.text.includes('"soon"') && n.text.includes('expires in 7 days'))).toBe(true);
    expect(d.notes.some((n) => n.text.includes('"gone"') && n.text.includes('expired on 2026-09-30'))).toBe(true);
  });
});

describe('ALZ custom roles', () => {
  it('defines the five ALZ roles with IDs fixed by the top management group and name', () => {
    const d = design({});
    expect(d.customRoles.map((r) => r.name)).toEqual([
      'Application-Owners',
      'Network-Management',
      'Network-Subnet-Contributor',
      'Security-Operations',
      'Subscription-Owner',
    ]);
    expect(d.customRoles[1].roleDefinitionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(design({}).customRoles[1].roleDefinitionId).toBe(d.customRoles[1].roleDefinitionId);
    expect(design({ prefix: 'fabrikam' }).customRoles[1].roleDefinitionId).not.toBe(d.customRoles[1].roleDefinitionId);
    expect(design({ alzCustomRoles: false }).customRoles).toEqual([]);
  });

  it('lets PIM manage them, with approval in the high profile only', () => {
    const pim = (frameworks: string[]) =>
      design({
        frameworks,
        pim: {
          enabled: true,
          profile: 'auto',
          roles: ['owner', 'alz:Network-Management'],
          eligibilities: [{ id: 'n', label: 'Network admins', role: 'alz:Network-Management', mg: 'connectivity' }],
        },
      }).pim!;
    const standard = pim([]);
    expect(standard.roles.find((r) => r.key === 'alz:Network-Management')).toMatchObject({ name: 'Network-Management', requireApproval: false });
    expect(standard.eligibilities.map((x) => x.id)).toEqual(['n']);
    expect(pim(['fedramp-high']).roles.every((r) => r.requireApproval)).toBe(true);
  });
});

describe('coverage reflects the design', () => {
  const nist = (input: Partial<DesignInput> = {}) => design({ frameworks: ['nist-800-53-r5'], nistBaseline: 'all', ...input }).coverage[0];
  const control = (cov: ReturnType<typeof nist>, id: string) => cov.families.flatMap((f) => f.controls).find((c) => c.id === id)!;

  it('marks manual-only controls excluded when they are turned off', () => {
    const before = nist();
    const after = nist({ excludeManualControls: true });
    expect(after.counts.excluded).toBe(before.counts.manual);
    expect(after.counts.manual).toBe(0);
    expect(after.counts.enforced + after.counts.audited).toBe(before.counts.enforced + before.counts.audited);
  });

  it('credits PIM for the controls it addresses that no policy evaluates', () => {
    const withPim = nist();
    const withoutPim = nist({ pim: { enabled: false, profile: 'auto', roles: [], eligibilities: [] } });
    expect(withPim.counts.pim).toBeGreaterThan(0);
    expect(withoutPim.counts.pim).toBe(0);
    for (const id of ['AC-2(6)', 'AC-2(7)', 'AC-6(5)', 'AC-6(7)', 'IA-2(1)', 'AC-2(4)']) {
      const c = control(withPim, id);
      expect(c.pim, id).toBe(true);
      if (c.automated.length === 0) expect(c.status, id).toBe('pim');
    }
  });

  it('lists excluded scopes and exemptions as "partly" applied', () => {
    const base = nist();
    const target = base.families.flatMap((f) => f.controls).find((c) => c.enforcedBy.length && c.exceptions.length === 0)!;
    const policy = target.automated[0];
    const holder = design({ frameworks: ['nist-800-53-r5'], nistBaseline: 'all' })
      .mgs.flatMap((m) => m.assignments.map((a) => ({ mg: m.role, a })))
      .find(({ a }) => a.policies.some((p) => p.p === policy) && a.enforcementMode === 'Default')!;
    const excluded = nist({ overrides: { [`${holder.mg}/${holder.a.name}`]: { notScopes: [{ kind: 'subscription', id: '1111' }] } } });
    expect(control(excluded, target.id).exceptions).toContain(`${holder.a.name} excludes 1111`);
    expect(excluded.partial).toBeGreaterThan(base.partial);
    const exempted = nist({
      exemptions: [{ id: 'x', mg: holder.mg, assignment: holder.a.name, scope: { kind: 'subscription', id: '2222' }, policies: [policy], category: 'Mitigated', reason: 'r' }],
    });
    expect(control(exempted, target.id).exceptions).toContain(`${holder.a.name} exempted at 2222 (mitigated)`);
  });
});

describe('custom assignments', () => {
  const index = JSON.parse(readFileSync(new URL('../../public/policy-index.json', import.meta.url), 'utf8')) as { policies: Record<string, PolicyInfo> };
  // A DeployIfNotExists built-in the catalog doesn't carry, only the policy index.
  const arc = '0adc5395-9169-4b9b-8687-af838d69410a';
  const custom = (c: Partial<CustomAssignment> = {}): CustomAssignment => ({
    id: 'c1',
    mg: 'corp',
    name: 'Deploy-Arc-Policy',
    displayName: 'Arc policy extension',
    kind: 'policy',
    definition: arc,
    info: index.policies[arc],
    enforcementMode: 'Default',
    parameters: {},
    ...c,
  });

  it('has every built-in policy in the index, the catalog\'s included', () => {
    expect(catalog.policies[arc]).toBeUndefined();
    expect(Object.keys(index.policies).length).toBeGreaterThan(Object.values(catalog.policies).filter((p) => p.t === 'BuiltIn').length);
    expect(index.policies[arc]).toMatchObject({ e: 'DeployIfNotExists', t: 'BuiltIn' });
  });

  it('assigns a built-in from the policy index at its management group', () => {
    const d = design({ customAssignments: [custom()] });
    const a = find(d, 'Deploy-Arc-Policy')!;
    expect(a.mg).toBe('corp');
    expect(a.a).toMatchObject({
      origin: 'custom',
      kind: 'policy',
      definitionId: `/providers/Microsoft.Authorization/policyDefinitions/${arc}`,
      definitionName: index.policies[arc].n,
      identity: true,
      policies: [{ p: arc, e: 'DeployIfNotExists' }],
    });
    expect(withCustomPolicies(catalog, d.input.customAssignments).policies[arc]).toEqual(index.policies[arc]);
  });

  it('takes its effect from an "effect" parameter', () => {
    const a = find(design({ customAssignments: [custom({ parameters: { effect: 'disabled' } })] }), 'Deploy-Arc-Policy')!.a;
    expect(a.policies).toEqual([{ p: arc, e: 'Disabled' }]);
    expect(a.identity).toBe(false);
    expect(a.parameters).toEqual({ effect: 'disabled' });
  });

  it('assigns a built-in initiative the catalog knows', () => {
    const iso = catalog.frameworks.find((f) => f.key === 'iso-27001-2022')!;
    expect(knownInitiatives(catalog).some((i) => i.id === iso.id)).toBe(true);
    const a = find(design({ customAssignments: [custom({ kind: 'initiative', definition: iso.id, name: 'Audit-ISO-Corp', info: undefined })] }), 'Audit-ISO-Corp')!.a;
    expect(a.policies).toHaveLength(iso.refs.length);
    expect(a.definitionId).toBe(`/providers/Microsoft.Authorization/policySetDefinitions/${iso.id}`);
  });

  it('leaves out clashing names, missing groups and unknown definitions, with a warning each', () => {
    const d = design({
      online: false,
      customAssignments: [
        custom({ id: '1', name: 'Deny-IP-forwarding', mg: 'landingzones' }),
        custom({ id: '2', mg: 'online' }),
        custom({ id: '3', name: 'Unknown', definition: '11111111-2222-3333-4444-555555555555', info: undefined }),
      ],
    });
    expect(d.mgs.flatMap((m) => m.assignments).filter((a) => a.origin === 'custom')).toHaveLength(0);
    expect(d.notes.filter((n) => n.level === 'warning' && n.text.startsWith('Custom assignment'))).toHaveLength(3);
  });

  it('assigns any built-in initiative from the initiative index, with the details of policies the catalog lacks', () => {
    const initiatives = JSON.parse(readFileSync(new URL('../../public/initiative-index.json', import.meta.url), 'utf8')) as InitiativeIndex;
    // Linux machines: Azure Monitor Agent and a data collection rule. Not a framework or ALZ initiative.
    const ama = '118f04da-0375-44d1-84e3-0fd9e1849403';
    expect(knownInitiatives(catalog).some((i) => i.id === ama)).toBe(false);
    const { members, infos } = initiativeMembers(catalog, { generated: '', ...index } as PolicyIndex, initiatives.initiatives[ama]);
    expect(members.length).toBe(new Set(initiatives.initiatives[ama].m.map((m) => m[0])).size);
    expect(Object.keys(infos).length).toBe(members.filter((m) => !catalog.policies[m.p]).length);
    expect(Object.values(infos).every((i) => i.d === '')).toBe(true);

    const d = design({ customAssignments: [custom({ kind: 'initiative', definition: ama, name: 'Deploy-AMA-Linux', displayName: '', info: undefined, members, infos })] });
    const a = find(d, 'Deploy-AMA-Linux')!.a;
    expect(a).toMatchObject({ kind: 'initiative', identity: true, definitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${ama}` });
    expect(a.policies.map((m) => m.p).sort()).toEqual(members.map((m) => m.p).sort());
    const merged = withCustomPolicies(catalog, d.input.customAssignments);
    for (const m of members) expect(merged.policies[m.p]?.n, m.p).toBeTruthy();
  });

  it('can be overridden and exempted like any assignment', () => {
    const d = design({
      customAssignments: [custom()],
      overrides: { 'corp/Deploy-Arc-Policy': { enforcementMode: 'DoNotEnforce' } },
      exemptions: [{ id: 'x', mg: 'corp', assignment: 'Deploy-Arc-Policy', scope: { kind: 'subscription', id: '1111' }, policies: [], category: 'Waiver', reason: 'r' }],
    });
    const a = find(d, 'Deploy-Arc-Policy')!.a;
    expect(a.enforcementMode).toBe('DoNotEnforce');
    expect(a.exemptions).toHaveLength(1);
  });
});
