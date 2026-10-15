// Turns framework selections and governance decisions into a suggested
// management group hierarchy, policy assignments and control coverage.
//
// The hierarchy and guardrails start from the Azure Landing Zones (ALZ)
// library; each selected framework's built-in regulatory compliance initiative
// is assigned in audit mode, and (depending on the enforcement posture) the
// framework's Deny-capable policies are gathered into a custom enforcement
// initiative for the landing zones.

import { BUILTIN_POLICY, canDeny, isAutomated, type Catalog, type Framework, type Member, type PolicyInfo } from './catalog';
import { familyOf } from './families';
import { DEFAULT_PIM, PIM_CONTROLS, buildPim, type PimDesign, type PimInput } from './pim';
import { uuidv5 } from './uuid';
import { DEFAULT_PRIVATE_DNS_CATEGORIES } from './privateDns';
import { DEFAULT_COST_QUANTITIES, type CostQuantities } from './cost';
import { DEFAULT_DEFENDER_PLANS, DEFENDER_PLANS } from './defender';

export { DEFAULT_DEFENDER_PLANS, DEFENDER_PLANS };

export type MgRole =
  | 'root'
  | 'platform'
  | 'connectivity'
  | 'identity'
  | 'management'
  | 'security'
  | 'landingzones'
  | 'corp'
  | 'online'
  | 'local'
  | 'confidential-corp'
  | 'confidential-online'
  | 'parkinglot'
  | 'sandbox'
  | 'decommissioned';

export type Baseline = 'low' | 'moderate' | 'high' | 'all';

/**
 * audit  – nothing blocks: Deny assignments run in DoNotEnforce mode.
 * alz    – the ALZ library defaults; framework Deny candidates in DoNotEnforce (what-if).
 * strict – every guardrail enforced, including the framework enforcement initiative.
 */
export type Enforcement = 'audit' | 'alz' | 'strict';

/** A scope inside the design: a management group, or a subscription / resource group by ID. */
export type ScopeRef =
  | { kind: 'managementGroup'; role: MgRole }
  | { kind: 'subscription'; id: string }
  | { kind: 'resourceGroup'; id: string };

/** Changes to one assignment, keyed `<management group role>/<assignment name>`. */
export interface AssignmentOverride {
  enforcementMode?: 'Default' | 'DoNotEnforce';
  /** Leave the assignment out of the design. */
  disabled?: boolean;
  /** Scopes the assignment doesn't apply to. */
  notScopes?: ScopeRef[];
  /** Parameter values that replace the defaults, by parameter name. */
  parameters?: Record<string, unknown>;
}

/** A policy exemption: the assignment (or some of its policies) doesn't apply at a scope. */
export interface Exemption {
  id: string;
  /** The assignment: its management group role and name. */
  mg: MgRole;
  assignment: string;
  scope: ScopeRef;
  /** Policy definition IDs exempted; empty for the whole assignment. */
  policies: string[];
  category: 'Waiver' | 'Mitigated';
  reason: string;
  /** yyyy-mm-dd, or empty for no expiry. */
  expiresOn?: string;
}

/** Exemptions that expire within this many days are flagged. */
export const EXPIRY_WARNING_DAYS = 30;

/** Whether an exemption has expired, expires soon, or is fine, and the days left. */
export function exemptionExpiry(e: Exemption, now = new Date()): { state: 'active' | 'expiring' | 'expired'; days: number | null } {
  if (!e.expiresOn) return { state: 'active', days: null };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [y, m, d] = e.expiresOn.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
  // Expires at the start of its day (UTC), so an exemption for today has expired.
  return { state: days <= 0 ? 'expired' : days <= EXPIRY_WARNING_DAYS ? 'expiring' : 'active', days };
}

export const overrideKey = (mg: MgRole, assignment: string) => `${mg}/${assignment}`;

export interface DesignInput {
  /** The design's name, shown in the top bar and the saved designs. */
  name: string;
  rootName: string;
  /** Prefix for management group IDs, e.g. "contoso" -> "contoso-platform". */
  prefix: string;
  cloud: 'AzureCloud' | 'AzureUSGovernment';
  frameworks: string[];
  /** Management group each framework's compliance initiative is assigned to (default root). */
  frameworkScopes: Partial<Record<string, MgRole>>;
  nistBaseline: Baseline;
  /** Add the SP 800-53B privacy baseline to the NIST controls in scope. */
  nistPrivacy: boolean;
  enforcement: Enforcement;
  /** "single": one platform subscription (connectivity, identity, management, security) in one Platform management group. */
  platform: 'full' | 'single';
  corp: boolean;
  online: boolean;
  /** Local landing zones, for Azure Local clusters in disconnected operations. Rarely needed, so off by default. */
  local: boolean;
  /** Confidential Corp / Online landing zones (Sovereign Landing Zone pattern). */
  confidential: boolean;
  sandbox: boolean;
  /**
   * A management group new subscriptions land in (the tenant's default
   * management group) until they're moved to their landing zone.
   */
  parkingLot: boolean;
  /**
   * locked: nothing can be deployed (a custom deny-everything policy, resource
   * groups included), so a subscription can only be moved out; sandbox: ALZ's
   * sandbox guardrails; inherit: only the root's.
   */
  parkingLotGuardrails: 'sandbox' | 'locked' | 'inherit';
  /** Tenant setting: only users with permission at the root can create management groups. */
  requireManagementGroupAuthorization: boolean;
  decommissioned: boolean;
  allowedLocations: string[];
  requiredTags: string[];
  defender: boolean;
  /** Defender for Cloud plans ALZ's Deploy-MDFC-Config enables (keys of DEFENDER_PLANS). */
  defenderPlans: string[];
  monitoring: boolean;
  backup: boolean;
  /** Enforce customer-managed keys (ALZ Enforce-Encrypt-CMK0). */
  cmk: boolean;
  /** Corp: deny public PaaS endpoints and deploy private DNS zone records. */
  privateCorp: boolean;
  /** DDoS Network Protection plan association. Off by default: a plan costs about US$2,944 a month. */
  ddos: boolean;
  /** Private DNS zone categories the IaC export creates (see privateDns.ts), when Corp is private-only. */
  privateDnsZones: string[];
  /** Sovereignty baseline initiatives (allowed locations, confidential computing). */
  sovereignty: boolean;
  overrides: Record<string, AssignmentOverride>;
  exemptions: Exemption[];
  /** Privileged Identity Management for Azure resource roles. */
  pim: PimInput;
  /** ALZ's custom roles (Network Management, Security Operations, ...), defined at the top management group. */
  alzCustomRoles: boolean;
  /**
   * Turn off the framework initiatives' manual-attestation policies (assignment
   * overrides in the export), so controls only they cover drop out of evaluation.
   */
  excludeManualControls: boolean;
  /** Assignments the user adds to management groups. */
  customAssignments: CustomAssignment[];
  /** Rough counts of the estate, for the cost estimate (cost.ts). */
  costQuantities: CostQuantities;
}


export const DEFAULT_INPUT: DesignInput = {
  name: 'Contoso governance',
  rootName: 'Contoso',
  prefix: 'contoso',
  cloud: 'AzureCloud',
  frameworks: ['nist-800-53-r5'],
  frameworkScopes: {},
  nistBaseline: 'moderate',
  nistPrivacy: false,
  enforcement: 'alz',
  platform: 'full',
  corp: true,
  online: true,
  local: false,
  confidential: false,
  sandbox: true,
  parkingLot: true,
  parkingLotGuardrails: 'locked',
  requireManagementGroupAuthorization: true,
  decommissioned: true,
  allowedLocations: ['eastus2', 'centralus'],
  requiredTags: ['CostCenter', 'Environment'],
  defender: true,
  defenderPlans: DEFAULT_DEFENDER_PLANS,
  monitoring: true,
  backup: true,
  cmk: false,
  privateCorp: true,
  ddos: false,
  privateDnsZones: DEFAULT_PRIVATE_DNS_CATEGORIES,
  sovereignty: false,
  overrides: {},
  exemptions: [],
  pim: DEFAULT_PIM,
  alzCustomRoles: true,
  excludeManualControls: false,
  customAssignments: [],
  costQuantities: DEFAULT_COST_QUANTITIES,
};

/** An ALZ custom role as the design defines it. */
export interface CustomRole {
  /** "alz:<role name>", for PIM. */
  key: string;
  /** ALZ's role name; the role is named "<name> (<root management group>)" so it's unique in the tenant. */
  name: string;
  description: string;
  /** Deterministic GUID: UUID v5 of "<root management group>/<name>". */
  roleDefinitionId: string;
}

/** Custom policy definition behind the locked parking lot. */
export const PARKING_LOT_POLICY = 'Deny-ParkingLot-Resources';

/**
 * Resource types the locked parking lot still allows: the security baseline the
 * root's DeployIfNotExists policies put in every subscription. Not user deployments.
 */
export const PARKING_LOT_ALLOWED_TYPES = [
  'Microsoft.Security/pricings',
  'Microsoft.Security/securityContacts',
  'Microsoft.Security/settings',
  'Microsoft.Security/autoProvisioningSettings',
  'Microsoft.Insights/diagnosticSettings',
];

export const GOV_LOCATIONS = ['usgovvirginia', 'usgovtexas', 'usgovarizona', 'usdodeast', 'usdodcentral'];

export type AssignmentOrigin = 'framework' | 'alz' | 'decision' | 'enforcement' | 'custom';

/** An assignment the user adds: any built-in policy, or a built-in initiative the catalog knows. */
export interface CustomAssignment {
  id: string;
  mg: MgRole;
  /** Assignment name, up to 24 characters. */
  name: string;
  displayName: string;
  kind: 'policy' | 'initiative';
  /** Built-in policy or initiative GUID. */
  definition: string;
  /** A built-in policy the catalog doesn't carry: its details, from the policy index. */
  info?: PolicyInfo;
  /** A built-in initiative the catalog doesn't know: its policies, from the initiative index. */
  members?: Member[];
  /** Those of its policies the catalog doesn't carry, from the policy index. */
  infos?: Record<string, PolicyInfo>;
  enforcementMode: 'Default' | 'DoNotEnforce';
  /** Parameter values by name; a string "effect" sets the policy's effect. */
  parameters: Record<string, unknown>;
}

/** A built-in initiative the catalog knows the members of. */
export interface KnownInitiative {
  id: string;
  name: string;
  description: string;
  policies: Member[];
}

/** Built-in initiatives a custom assignment can use: the frameworks, the extra initiatives and ALZ's built-in ones. */
export function knownInitiatives(catalog: Catalog): KnownInitiative[] {
  const out = new Map<string, KnownInitiative>();
  for (const f of catalog.frameworks)
    out.set(f.id.toLowerCase(), { id: f.id, name: f.name, description: f.description, policies: f.refs.map((r) => ({ p: r.p, e: r.e, ...(r.r ? { r: [r.r] } : {}) })) });
  for (const i of Object.values(catalog.initiatives)) out.set(i.id.toLowerCase(), { id: i.id, name: i.name, description: i.description, policies: i.policies });
  for (const a of Object.values(catalog.alz.assignments)) {
    if (a.kind !== 'initiative' || a.source !== 'BuiltIn') continue;
    const id = a.definitionId.split('/').pop()!;
    if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), { id, name: a.definitionName ?? a.displayName, description: a.description, policies: a.policies });
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** The catalog plus the policies custom assignments brought from the policy index. */
export function withCustomPolicies(catalog: Catalog, custom: CustomAssignment[] | undefined): Catalog {
  const extra: Record<string, PolicyInfo> = {};
  for (const c of custom ?? []) {
    if (c.info && !catalog.policies[c.definition]) extra[c.definition] = c.info;
    for (const [p, info] of Object.entries(c.infos ?? {})) if (!catalog.policies[p]) extra[p] = info;
  }
  if (!Object.keys(extra).length) return catalog;
  return { ...catalog, policies: { ...catalog.policies, ...extra } };
}

/** The value of a parameter named "effect" (any case), when it's a string. */
export function effectParameter(parameters: Record<string, unknown> | undefined): string | undefined {
  const key = Object.keys(parameters ?? {}).find((k) => k.toLowerCase() === 'effect');
  const value = key ? parameters![key] : undefined;
  return typeof value === 'string' && value ? value[0].toUpperCase() + value.slice(1) : undefined;
}

export interface PlannedAssignment {
  /** Assignment name (max 24 characters at management group scope). */
  name: string;
  displayName: string;
  description: string;
  origin: AssignmentOrigin;
  kind: 'policy' | 'initiative';
  definitionId: string;
  definitionName: string;
  definitionSource: 'BuiltIn' | 'ALZ' | 'Custom';
  enforcementMode: 'Default' | 'DoNotEnforce';
  /** Whether the assignment needs a managed identity (DeployIfNotExists / Modify). */
  identity: boolean;
  policies: Member[];
  frameworkKey?: string;
  /** Why the assignment is in the design. */
  rationale: string;
  /** How a decision changed it from the ALZ library default. */
  change?: string;
  parameters?: Record<string, unknown>;
  /** Scopes excluded by an override. */
  notScopes?: ScopeRef[];
  /** Whether an override changed the assignment. */
  overridden?: boolean;
  exemptions: Exemption[];
}

export interface PlannedMg {
  role: MgRole;
  id: string;
  displayName: string;
  parent: MgRole | null;
  description: string;
  assignments: PlannedAssignment[];
  /** Assignments an override took out of the design. */
  removed: string[];
}

/**
 * enforced / audited: by policy; pim: no policy evaluates it, but PIM addresses it;
 * manual: only manual-attestation policies; excluded: only manual policies, turned off
 * by "Exclude manual-only controls"; none: no policy.
 */
export type ControlStatus = 'enforced' | 'audited' | 'pim' | 'manual' | 'excluded' | 'none';

export interface ControlCoverage {
  id: string;
  title?: string;
  status: ControlStatus;
  /** Automated (resource-evaluating) policies mapped to the control. */
  automated: string[];
  /** Manual attestation policies mapped to the control. */
  manual: number;
  /** Names of design assignments that enforce one of the control's policies. */
  enforcedBy: string[];
  /** Where its policies don't apply: excluded scopes and exemptions ("partly"). */
  exceptions: string[];
  /** Privileged Identity Management helps address it. */
  pim: boolean;
}

export interface FamilyCoverage {
  code: string;
  title: string;
  controls: ControlCoverage[];
  counts: Record<ControlStatus, number>;
}

export interface FrameworkCoverage {
  key: string;
  short: string;
  name: string;
  framework: Framework;
  scope: MgRole;
  /** Controls in scope (after the NIST baseline filter). */
  inScope: number;
  /** Controls whose policies don't apply everywhere (excluded scopes, exemptions). */
  partial: number;
  outOfBaseline: number;
  counts: Record<ControlStatus, number>;
  families: FamilyCoverage[];
  automatedPolicies: number;
  manualPolicies: number;
}

export interface PolicyRow {
  id: string;
  /** Selected frameworks mapping the policy, with the controls it maps to. */
  frameworks: { key: string; controls: string[] }[];
  /** Where the design assigns the policy. */
  placements: { mg: MgRole; assignment: string; effect: string; enforced: boolean }[];
}

export interface Note {
  level: 'warning' | 'info';
  text: string;
}

export interface Design {
  input: DesignInput;
  mgs: PlannedMg[];
  coverage: FrameworkCoverage[];
  policies: PolicyRow[];
  notes: Note[];
  /** Privileged Identity Management, or null when it's off. */
  pim: PimDesign | null;
  customRoles: CustomRole[];
  stats: {
    managementGroups: number;
    assignments: number;
    uniquePolicies: number;
    enforcingAssignments: number;
    frameworkPolicies: number;
  };
}

const DEFENDER_ASSIGNMENT = 'Deploy-MDFC-Config-H224';

/** Members whose effect is wired to a parameter the assignment sets take that value. */
function applyEffectParameters(policies: Member[], parameters: Record<string, unknown> | undefined): Member[] {
  if (!parameters) return policies;
  return policies.map((m) => (m.ep && typeof parameters[m.ep] === 'string' ? { ...m, e: parameters[m.ep] as string } : m));
}

/** Effects that change or block resources rather than only reporting. */
export const ENFORCING_EFFECTS = new Set(['Deny', 'DenyAction', 'DeployIfNotExists', 'Modify', 'Append']);
const NEEDS_IDENTITY = new Set(['DeployIfNotExists', 'Modify']);

export const MG_ORDER: MgRole[] = [
  'root',
  'platform',
  'connectivity',
  'identity',
  'management',
  'security',
  'landingzones',
  'corp',
  'online',
  'local',
  'confidential-corp',
  'confidential-online',
  'parkinglot',
  'sandbox',
  'decommissioned',
];

/** ALZ assignments a decision can switch off, and why. */
const ALZ_TOGGLES: Record<string, { decision: keyof DesignInput; label: string }> = {
  'Deploy-MDFC-Config-H224': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-MDEndpoints': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-MDEndpointsAMA': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-MDFC-OssDb': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-MDFC-SqlAtp': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-MDFC-DefSQL-AMA': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-SQL-Threat': { decision: 'defender', label: 'Defender for Cloud' },
  'Deploy-AzActivity-Log': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-Diag-LogsCat': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-VM-Monitoring': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-VMSS-Monitoring': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-vmHybr-Monitoring': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-VM-ChangeTrack': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-VMSS-ChangeTrack': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-vmArc-ChangeTrack': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-AzSqlDb-Auditing': { decision: 'monitoring', label: 'central monitoring' },
  'DenyAction-DeleteUAMIAMA': { decision: 'monitoring', label: 'central monitoring' },
  'Deploy-VM-Backup': { decision: 'backup', label: 'backup' },
  'Enforce-ASR': { decision: 'backup', label: 'backup' },
  'Deploy-Private-DNS-Zones': { decision: 'privateCorp', label: 'private-only Corp' },
  'Deny-Public-Endpoints': { decision: 'privateCorp', label: 'private-only Corp' },
  'Enable-DDoS-VNET': { decision: 'ddos', label: 'DDoS Network Protection' },
};

/** ALZ assignments that already cover a framework's built-in initiative. */
const ALZ_FRAMEWORK_EQUIVALENT: Record<string, string> = {
  mcsb: 'Deploy-ASC-Monitoring',
};

const MG_DESCRIPTIONS: Record<MgRole, string> = {
  root: 'Intermediate root under the tenant root group. Organization-wide guardrails and compliance auditing.',
  platform: 'Shared platform services: identity, management, connectivity and security.',
  connectivity: 'Hub networking: Azure Firewall, VPN/ExpressRoute gateways, private DNS zones.',
  identity: 'Domain controllers and identity services.',
  management: 'Log Analytics, Automation and other central management tooling.',
  security: 'Security tooling such as Microsoft Sentinel.',
  landingzones: 'Application landing zones. Workload guardrails apply to every child.',
  corp: 'Workloads that are private and connected to the corporate network through the hub.',
  online: 'Internet-facing workloads that may have public endpoints.',
  local: 'Azure Local clusters in disconnected operations. Resource types they do not support are audited.',
  'confidential-corp': 'Corp workloads that must run on confidential computing with customer-managed keys.',
  'confidential-online': 'Online workloads that must run on confidential computing with customer-managed keys.',
  parkinglot: 'Where new subscriptions land (the default management group) until they are moved to their landing zone.',
  sandbox: 'Experimentation subscriptions, isolated from corporate networks.',
  decommissioned: 'Subscriptions being cancelled; resource creation is blocked.',
};

/** Effect summary of a set of members: "Deny", or "Mixed" with counts. */
export function effectSummary(members: Member[]): { label: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const m of members) counts[m.e || 'Default'] = (counts[m.e || 'Default'] ?? 0) + 1;
  const keys = Object.keys(counts);
  return { label: keys.length === 1 ? keys[0] : 'Mixed', counts };
}

/** Builds an assignment name that fits Azure's 24-character limit at management group scope. */
export function assignmentName(base: string): string {
  return base.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '');
}

export function frameworkAssignmentName(f: Framework): string {
  return assignmentName(`Audit-${f.short}`);
}

export const BASELINE_CODE: Record<Exclude<Baseline, 'all'>, 'L' | 'M' | 'H'> = { low: 'L', moderate: 'M', high: 'H' };

/** Whether a NIST SP 800-53 Rev. 5 control is in the selected baseline(s). */
export function inNistBaseline(catalog: Catalog, control: string, baseline: Baseline, privacy: boolean): boolean {
  if (baseline === 'all') return true;
  const b = catalog.nist.controls[control]?.b ?? [];
  return b.includes(BASELINE_CODE[baseline]) || (privacy && b.includes('P'));
}

function mgId(prefix: string, role: MgRole): string {
  const p = prefix.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'alz';
  return role === 'root' ? p : `${p}-${role}`;
}

export function buildDesign(baseCatalog: Catalog, input: DesignInput, now = new Date()): Design {
  const catalog = withCustomPolicies(baseCatalog, input.customAssignments);
  const notes: Note[] = [];
  const frameworks = input.frameworks
    .map((k) => catalog.frameworks.find((f) => f.key === k))
    .filter((f): f is Framework => !!f);

  // --- Management groups ---------------------------------------------------

  const roles: { role: MgRole; parent: MgRole | null; archetypes: string[]; displayName: string }[] = [];
  const add = (role: MgRole, parent: MgRole | null, archetypes: string[], displayName: string) =>
    roles.push({ role, parent, archetypes, displayName });

  add('root', null, ['root'], input.rootName.trim() || 'Azure Landing Zones');
  if (input.platform === 'full') {
    add('platform', 'root', ['platform'], 'Platform');
    add('connectivity', 'platform', ['connectivity'], 'Connectivity');
    add('identity', 'platform', ['identity'], 'Identity');
    add('management', 'platform', ['management'], 'Management');
    add('security', 'platform', ['security'], 'Security');
  } else {
    // ALZ's simplified option: connectivity guardrails move up; identity's
    // public-IP denials would block hub firewalls, so they are left out.
    add('platform', 'root', ['platform', 'connectivity', 'management', 'security'], 'Platform');
    notes.push({
      level: 'info',
      text: 'Single platform subscription: connectivity, identity, management and security share one subscription in the Platform management group, which gets the connectivity, management and security guardrails. The Identity archetype (deny public IPs, management ports and subnets without NSGs) is not assigned, because it would block hub networking.',
    });
  }
  add('landingzones', 'root', ['landing_zones'], 'Landing zones');
  if (input.corp) add('corp', 'landingzones', ['corp'], 'Corp');
  if (input.online) add('online', 'landingzones', ['online'], 'Online');
  if (input.local) add('local', 'landingzones', ['local'], 'Local');
  if (input.confidential) {
    add('confidential-corp', 'landingzones', ['corp'], 'Confidential Corp');
    add('confidential-online', 'landingzones', ['online'], 'Confidential Online');
  }
  if (input.parkingLot) add('parkinglot', 'root', input.parkingLotGuardrails === 'sandbox' ? ['sandbox'] : [], 'Parking lot');
  if (input.sandbox) add('sandbox', 'root', ['sandbox'], 'Sandbox');
  if (input.decommissioned) add('decommissioned', 'root', ['decommissioned'], 'Decommissioned');

  const present = new Set(roles.map((r) => r.role));
  const mgs: PlannedMg[] = roles.map((r) => ({
    role: r.role,
    id: mgId(input.prefix, r.role),
    displayName: r.displayName,
    parent: r.parent,
    description: MG_DESCRIPTIONS[r.role],
    assignments: [],
    removed: [],
  }));
  const gov = input.cloud === 'AzureUSGovernment';
  /** In Azure Government, built-ins it doesn't have are left out. */
  const available = (m: Member) => !gov || !catalog.policies[m.p]?.ng;
  const mgByRole = new Map(mgs.map((m) => [m.role, m]));

  // --- ALZ assignments -----------------------------------------------------

  const omitted = new Map<string, string>();
  const omittedGov = new Set<string>();
  for (const r of roles) {
    const mg = mgByRole.get(r.role)!;
    for (const archetype of r.archetypes) {
      for (const name of catalog.alz.archetypes[archetype] ?? []) {
        const a = catalog.alz.assignments[name];
        if (!a || mg.assignments.some((x) => x.name === name)) continue;
        const toggle = ALZ_TOGGLES[name];
        if (toggle && !input[toggle.decision]) {
          omitted.set(name, toggle.label);
          continue;
        }
        // In Azure Government, also when none of its policies are there (an empty initiative can't be created).
        if (gov && (a.usGov === false || (a.policies.length && !a.policies.some(available)))) {
          omittedGov.add(name);
          continue;
        }
        let enforcementMode = a.enforcementMode;
        let change: string | undefined;
        const enforcing = a.policies.some((m) => m.e === 'Deny' || m.e === 'DenyAction');
        if (name === 'Enforce-Encrypt-CMK0' && input.cmk && enforcementMode === 'DoNotEnforce') {
          enforcementMode = 'Default';
          change = 'Enforced because customer-managed keys are required.';
        } else if (input.enforcement === 'strict' && enforcementMode === 'DoNotEnforce' && name !== 'Enforce-Encrypt-CMK0') {
          enforcementMode = 'Default';
          change = 'Enforced by the strict posture (ALZ ships it in DoNotEnforce).';
        } else if (input.enforcement === 'audit' && enforcing && enforcementMode === 'Default') {
          enforcementMode = 'DoNotEnforce';
          change = 'Set to DoNotEnforce by the audit-first posture: non-compliance is reported, nothing is blocked.';
        }
        let parameters: Record<string, unknown> | undefined;
        if (name === DEFENDER_ASSIGNMENT) {
          const plans = new Set(input.defenderPlans ?? DEFAULT_DEFENDER_PLANS);
          parameters = Object.fromEntries(
            DEFENDER_PLANS.map((p) => [`enableAscFor${p.key}`, plans.has(p.key) ? 'DeployIfNotExists' : 'Disabled']),
          );
          const on = DEFENDER_PLANS.filter((p) => plans.has(p.key));
          change = on.length
            ? `Enables Defender plans: ${on.map((p) => p.label).join(', ')} (ALZ ships most of them Disabled).`
            : 'No Defender plans enabled; security contacts and continuous export only.';
        }
        mg.assignments.push({
          name,
          displayName: a.displayName,
          description: a.description,
          origin: 'alz',
          kind: a.kind,
          definitionId: a.definitionId,
          definitionName: a.definitionName ?? a.displayName,
          definitionSource: a.source,
          enforcementMode,
          identity: a.identity,
          policies: applyEffectParameters(a.policies.filter(available), parameters),
          rationale: `ALZ ${archetype.replace('_', ' ')} archetype.`,
          change,
          ...(parameters ? { parameters } : {}),
          exemptions: [],
        });
      }
    }
  }
  if (omittedGov.size)
    notes.push({
      level: 'info',
      text: `Not available in Azure Government, so left out: ${[...omittedGov].join(', ')}. Built-in policies Azure Government doesn't have are also left out of the other assignments (availability from AzAdvertizer).`,
    });
  if (omitted.size) {
    const byLabel = new Map<string, string[]>();
    for (const [name, label] of omitted) byLabel.set(label, [...(byLabel.get(label) ?? []), name]);
    for (const [label, names] of byLabel)
      notes.push({ level: 'info', text: `Left out because ${label} is turned off: ${names.join(', ')}.` });
  }

  // --- Decision assignments ------------------------------------------------

  const root = mgByRole.get('root')!;
  const lz = mgByRole.get('landingzones')!;
  const locations = input.allowedLocations.map((l) => l.trim()).filter(Boolean);
  const policy = (id: string, e?: string): Member => ({ p: id, e: e ?? catalog.policies[id]?.e ?? '' });
  const builtInPolicyId = (id: string) => `/providers/Microsoft.Authorization/policyDefinitions/${id}`;

  if (input.sovereignty) {
    const g = catalog.initiatives['sovereignty-global'];
    root.assignments.push({
      name: 'Enforce-Sovereign-Global',
      displayName: g.name,
      description: g.description,
      origin: 'decision',
      kind: 'initiative',
      definitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${g.id}`,
      definitionName: g.name,
      definitionSource: 'BuiltIn',
      enforcementMode: input.enforcement === 'audit' ? 'DoNotEnforce' : 'Default',
      identity: false,
      policies: g.policies,
      rationale: 'Sovereignty: keeps resources in approved regions and requires Trusted Launch.',
      exemptions: [],
      parameters: { listOfAllowedLocations: locations },
    });
    if (!locations.length)
      notes.push({ level: 'warning', text: 'The sovereignty baseline needs at least one allowed location.' });
  } else if (locations.length) {
    for (const [name, id, what] of [
      ['Enforce-Allowed-Locs', BUILTIN_POLICY.allowedLocations, 'resources'],
      ['Enforce-Allowed-RG-Locs', BUILTIN_POLICY.allowedLocationsRg, 'resource groups'],
    ] as const) {
      root.assignments.push({
        name,
        displayName: `Allowed locations for ${what}`,
        description: `Restricts ${what} to ${locations.join(', ')}. Global resources are not affected.`,
        origin: 'decision',
        kind: 'policy',
        definitionId: builtInPolicyId(id),
        definitionName: catalog.policies[id]?.n ?? 'Allowed locations',
        definitionSource: 'BuiltIn',
        enforcementMode: input.enforcement === 'audit' ? 'DoNotEnforce' : 'Default',
        identity: false,
        policies: [policy(id, 'Deny')],
        rationale: 'Data residency: allowed locations decision.',
        exemptions: [],
        parameters: { listOfAllowedLocations: locations },
      });
    }
  }

  for (const tag of input.requiredTags.map((t) => t.trim()).filter(Boolean)) {
    lz.assignments.push({
      name: assignmentName(`Require-Tag-${tag}`),
      displayName: `Require tag '${tag}' on resource groups`,
      description: `Resource groups must have the '${tag}' tag.`,
      origin: 'decision',
      kind: 'policy',
      definitionId: builtInPolicyId(BUILTIN_POLICY.requireTagRg),
      definitionName: catalog.policies[BUILTIN_POLICY.requireTagRg]?.n ?? 'Require a tag on resource groups',
      definitionSource: 'BuiltIn',
      enforcementMode: input.enforcement === 'audit' ? 'DoNotEnforce' : 'Default',
      identity: false,
      policies: [policy(BUILTIN_POLICY.requireTagRg, 'Deny')],
      rationale: 'Required tags decision.',
      exemptions: [],
      parameters: { tagName: tag },
    });
    lz.assignments.push({
      name: assignmentName(`Inherit-Tag-${tag}`),
      displayName: `Inherit tag '${tag}' from the resource group`,
      description: `Copies '${tag}' from the resource group to resources that don't have it.`,
      origin: 'decision',
      kind: 'policy',
      definitionId: builtInPolicyId(BUILTIN_POLICY.inheritTag),
      definitionName: catalog.policies[BUILTIN_POLICY.inheritTag]?.n ?? 'Inherit a tag from the resource group if missing',
      definitionSource: 'BuiltIn',
      enforcementMode: 'Default',
      identity: true,
      policies: [policy(BUILTIN_POLICY.inheritTag, 'Modify')],
      rationale: 'Required tags decision.',
      exemptions: [],
      parameters: { tagName: tag },
    });
  }

  if (input.parkingLot && input.parkingLotGuardrails === 'locked') {
    // The built-in "Allowed resource types" is Indexed, so it misses resource groups
    // and resources without a location; this custom definition is mode All.
    mgByRole.get('parkinglot')!.assignments.push({
      name: 'Deny-Parking-Resources',
      displayName: 'No deployments in parking lot subscriptions',
      description:
        'Denies creating or changing any resource, resource group or subscription setting until the subscription is moved to its landing zone. Only the platform security baseline (Defender for Cloud, activity log) is allowed.',
      origin: 'decision',
      kind: 'policy',
      definitionId: `/providers/Microsoft.Management/managementGroups/${mgId(input.prefix, 'root')}/providers/Microsoft.Authorization/policyDefinitions/${PARKING_LOT_POLICY}`,
      definitionName: 'Deny resources in parking lot subscriptions',
      definitionSource: 'Custom',
      // Always enforced: an audit-only parking lot would let anything through.
      enforcementMode: 'Default',
      identity: false,
      policies: [{ p: PARKING_LOT_POLICY, e: 'Deny' }],
      rationale: 'Locked parking lot: a subscription can only be moved in or out; nothing can be deployed until it is placed.',
      exemptions: [],
    });
  }

  if (input.confidential) {
    const c = catalog.initiatives['sovereignty-confidential'];
    for (const role of ['confidential-corp', 'confidential-online'] as const) {
      mgByRole.get(role)!.assignments.push({
        name: 'Enforce-Sovereign-Conf',
        displayName: c.name,
        description: c.description,
        origin: 'decision',
        kind: 'initiative',
        definitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${c.id}`,
        definitionName: c.name,
        definitionSource: 'BuiltIn',
        enforcementMode: input.enforcement === 'audit' ? 'DoNotEnforce' : 'Default',
        identity: false,
        policies: c.policies,
        rationale: 'Confidential landing zones: confidential computing SKUs and customer-managed keys.',
        exemptions: [],
        parameters: { listOfAllowedLocations: locations },
      });
    }
  }

  // --- Framework compliance initiatives ------------------------------------

  for (const f of frameworks) {
    const equivalent = ALZ_FRAMEWORK_EQUIVALENT[f.key];
    const existing = equivalent && root.assignments.find((a) => a.name === equivalent);
    if (existing) {
      existing.frameworkKey = f.key;
      existing.rationale += ` Also provides the ${f.short} compliance view.`;
      continue;
    }
    if (gov && f.usGov === false) {
      notes.push({ level: 'warning', text: `${f.name} is not available in Azure Government, so it isn't assigned.` });
      continue;
    }
    const wanted = input.frameworkScopes[f.key] ?? 'root';
    const scope = present.has(wanted) ? wanted : 'root';
    const policies = f.refs.map((r) => ({ p: r.p, e: r.e, ...(r.r ? { r: [r.r] } : {}) })).filter(available);
    mgByRole.get(scope)!.assignments.push({
      name: frameworkAssignmentName(f),
      displayName: f.name,
      description: f.description,
      origin: 'framework',
      kind: 'initiative',
      definitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${f.id}`,
      definitionName: f.name,
      definitionSource: 'BuiltIn',
      // Regulatory compliance initiatives are audit-only by design.
      enforcementMode: 'Default',
      identity: policies.some((m) => NEEDS_IDENTITY.has(m.e)),
      policies,
      frameworkKey: f.key,
      rationale:
        scope === 'root'
          ? `${f.short} compliance dashboard across every subscription (audit-only).`
          : `${f.short} compliance dashboard for the ${mgByRole.get(scope)!.displayName} scope (audit-only).`,
      exemptions: [],
    });
  }

  // --- Custom assignments ----------------------------------------------------

  const initiatives = new Map(knownInitiatives(catalog).map((i) => [i.id.toLowerCase(), i]));
  for (const c of input.customAssignments ?? []) {
    const mg = mgByRole.get(c.mg);
    const label = c.displayName || c.name;
    if (!mg) {
      notes.push({ level: 'warning', text: `Custom assignment "${label}" is for the ${c.mg} management group, which isn't in the design.` });
      continue;
    }
    if (mg.assignments.some((a) => a.name === c.name)) {
      notes.push({ level: 'warning', text: `Custom assignment "${label}" has the same name as another assignment at ${mg.displayName} (${c.name}), so it's left out.` });
      continue;
    }
    let policies: Member[];
    let definitionName: string;
    let description: string;
    if (c.kind === 'initiative') {
      const known =
        initiatives.get(c.definition.toLowerCase()) ??
        (c.members?.length ? { id: c.definition, name: c.displayName || c.name, description: '', policies: c.members } : undefined);
      if (!known) {
        notes.push({ level: 'warning', text: `Custom assignment "${label}": initiative ${c.definition} isn't in the catalog, so it's left out.` });
        continue;
      }
      policies = applyEffectParameters(known.policies.filter(available), c.parameters);
      definitionName = known.name;
      description = known.description;
    } else {
      const info = catalog.policies[c.definition];
      if (!info) {
        notes.push({ level: 'warning', text: `Custom assignment "${label}": policy ${c.definition} isn't in the catalog or the policy index, so it's left out.` });
        continue;
      }
      if (gov && info.ng) {
        notes.push({ level: 'warning', text: `Custom assignment "${label}": ${info.n} isn't available in Azure Government, so it's left out.` });
        continue;
      }
      policies = [{ p: c.definition, e: effectParameter(c.parameters) ?? info.e }];
      definitionName = info.n;
      description = info.d ?? '';
    }
    mg.assignments.push({
      name: c.name,
      displayName: c.displayName || definitionName,
      description: description.slice(0, 512),
      origin: 'custom',
      kind: c.kind,
      definitionId: `/providers/Microsoft.Authorization/${c.kind === 'initiative' ? 'policySetDefinitions' : 'policyDefinitions'}/${c.definition}`,
      definitionName,
      definitionSource: 'BuiltIn',
      enforcementMode: c.enforcementMode,
      identity: policies.some((m) => NEEDS_IDENTITY.has(m.e)),
      policies,
      rationale: 'Added to the design by hand.',
      exemptions: [],
      ...(Object.keys(c.parameters ?? {}).length ? { parameters: c.parameters } : {}),
    });
  }

  // --- Framework enforcement initiative ------------------------------------

  // Controls in scope per framework (the NIST baseline filter applies to 800-53 R5).
  const controlInScope = (f: Framework, control: string) =>
    !f.nist || inNistBaseline(catalog, control, input.nistBaseline, input.nistPrivacy);

  const enforcedAt = (role: MgRole): Set<string> => {
    const out = new Set<string>();
    for (let r: MgRole | null = role; r; r = mgByRole.get(r)?.parent ?? null) {
      for (const a of mgByRole.get(r)?.assignments ?? [])
        if (a.enforcementMode === 'Default') for (const m of a.policies) if (m.e === 'Deny') out.add(m.p);
    }
    return out;
  };

  if (input.enforcement !== 'audit' && frameworks.length) {
    const already = enforcedAt('landingzones');
    const candidates = new Map<string, Set<string>>();
    for (const f of frameworks) {
      for (const ref of f.refs) {
        const p = catalog.policies[ref.p];
        if (!p || p.dp || p.pv || !canDeny(p) || already.has(ref.p) || (gov && p.ng)) continue;
        if (!ref.g.some((c) => controlInScope(f, c))) continue;
        if (!candidates.has(ref.p)) candidates.set(ref.p, new Set());
        candidates.get(ref.p)!.add(f.short);
      }
    }
    if (candidates.size) {
      const label = frameworks.map((f) => f.short).join(', ');
      // Azure limits display names to 128 characters.
      const title = `Enforce ${label} guardrails`.length <= 128 ? `Enforce ${label} guardrails` : `Enforce guardrails of ${frameworks.length} frameworks`;
      lz.assignments.push({
        name: 'Enforce-Framework-GR',
        displayName: title,
        description: `Custom initiative: the ${candidates.size} Deny-capable policies mapped to in-scope ${label} controls that ALZ doesn't already enforce, set to Deny.`,
        origin: 'enforcement',
        kind: 'initiative',
        definitionId: `/providers/Microsoft.Management/managementGroups/${root.id}/providers/Microsoft.Authorization/policySetDefinitions/Enforce-Framework-GR`,
        definitionName: title,
        definitionSource: 'Custom',
        enforcementMode: input.enforcement === 'strict' ? 'Default' : 'DoNotEnforce',
        identity: false,
        policies: [...candidates.keys()].map((p) => ({ p, e: 'Deny' })),
        rationale:
          input.enforcement === 'strict'
            ? 'Strict posture: framework policies that can deny are enforced on landing zones.'
            : 'What-if: framework policies that can deny run in DoNotEnforce, so you can see what would be blocked before enforcing.',
        exemptions: [],
      });
    }
  }

  // --- Overrides and exemptions --------------------------------------------

  const roleOf = new Map(mgs.map((m) => [m.role, m]));
  const within = (role: MgRole, ancestor: MgRole) => {
    for (let r: MgRole | null = role; r; r = roleOf.get(r)?.parent ?? null) if (r === ancestor) return true;
    return false;
  };
  const scopeLabel = (scope: ScopeRef) => (scope.kind === 'managementGroup' ? (roleOf.get(scope.role)?.displayName ?? scope.role) : scope.id);
  for (const mg of mgs) {
    mg.assignments = mg.assignments.filter((a) => {
      const o = input.overrides?.[overrideKey(mg.role, a.name)];
      if (!o) return true;
      if (o.disabled) {
        mg.removed.push(a.name);
        return false;
      }
      const changes: string[] = [];
      if (o.enforcementMode && o.enforcementMode !== a.enforcementMode) {
        a.enforcementMode = o.enforcementMode;
        changes.push(o.enforcementMode === 'Default' ? 'enforced' : 'set to DoNotEnforce');
      }
      const notScopes = (o.notScopes ?? []).filter((n) => n.kind !== 'managementGroup' || (roleOf.has(n.role) && within(n.role, mg.role)));
      if (notScopes.length) {
        a.notScopes = notScopes;
        changes.push(`excludes ${notScopes.map(scopeLabel).join(', ')}`);
      }
      if (o.parameters && Object.keys(o.parameters).length) {
        a.parameters = { ...(a.parameters ?? {}), ...o.parameters };
        a.policies = applyEffectParameters(a.policies, a.parameters);
        changes.push(`parameters ${Object.keys(o.parameters).join(', ')}`);
      }
      if (changes.length) {
        a.overridden = true;
        a.change = `Overridden: ${changes.join('; ')}.`;
      }
      return true;
    });
  }
  for (const e of input.exemptions ?? []) {
    const a = roleOf.get(e.mg)?.assignments.find((x) => x.name === e.assignment);
    if (!a) {
      notes.push({ level: 'warning', text: `Exemption "${e.reason || e.id}" is for ${e.assignment}, which isn't in the design any more.` });
      continue;
    }
    if (e.scope.kind === 'managementGroup' && !(roleOf.has(e.scope.role) && within(e.scope.role, e.mg))) {
      notes.push({ level: 'warning', text: `Exemption "${e.reason || e.id}" is outside ${a.name}'s scope, so it has no effect.` });
      continue;
    }
    const expiry = exemptionExpiry(e, now);
    if (expiry.state === 'expired') {
      // It no longer applies, and Azure won't create an exemption that has expired.
      notes.push({
        level: 'warning',
        text: `Exemption "${e.reason || e.id}" on ${a.name} expired on ${e.expiresOn}, so it no longer applies and isn't exported. Renew or remove it.`,
      });
      continue;
    }
    if (expiry.state === 'expiring')
      notes.push({
        level: 'warning',
        text: `Exemption "${e.reason || e.id}" on ${a.name} expires in ${expiry.days} day${expiry.days === 1 ? '' : 's'} (${e.expiresOn}).`,
      });
    a.exemptions.push(e);
  }

  // --- Coverage ------------------------------------------------------------

  const enforcingPlacements = new Map<string, string[]>();
  for (const mg of mgs)
    for (const a of mg.assignments)
      if (a.enforcementMode === 'Default')
        for (const m of a.policies)
          if (ENFORCING_EFFECTS.has(m.e)) enforcingPlacements.set(m.p, [...(enforcingPlacements.get(m.p) ?? []), a.name]);

  // Where each policy doesn't apply: the excluded scopes and exemptions of the assignments that carry it.
  const exceptionsByPolicy = new Map<string, Set<string>>();
  for (const mg of mgs)
    for (const a of mg.assignments) {
      const excluded = a.notScopes?.length ? [`${a.name} excludes ${a.notScopes.map(scopeLabel).join(', ')}`] : [];
      for (const m of a.policies) {
        const exempt = a.exemptions
          .filter((e) => !e.policies.length || e.policies.includes(m.p))
          .map((e) => `${a.name} exempted at ${scopeLabel(e.scope)} (${e.category.toLowerCase()})`);
        if (!excluded.length && !exempt.length) continue;
        if (!exceptionsByPolicy.has(m.p)) exceptionsByPolicy.set(m.p, new Set());
        for (const x of [...excluded, ...exempt]) exceptionsByPolicy.get(m.p)!.add(x);
      }
    }
  const pimOn = (input.pim ?? DEFAULT_PIM).enabled;

  const assigned = new Set(mgs.flatMap((m) => m.assignments.map((a) => a.frameworkKey)).filter(Boolean));
  const coverage: FrameworkCoverage[] = frameworks.filter((f) => assigned.has(f.key)).map((f) => {
    const byControl = new Map<string, { automated: Set<string>; manual: number }>();
    for (const c of f.controls) byControl.set(c, { automated: new Set(), manual: 0 });
    const automatedIds = new Set<string>();
    const manualIds = new Set<string>();
    for (const ref of f.refs) {
      const p = catalog.policies[ref.p];
      if (gov && p?.ng) continue;
      const auto = isAutomated(p, ref.e) && ref.e !== 'Disabled';
      for (const c of ref.g) {
        const entry = byControl.get(c) ?? { automated: new Set<string>(), manual: 0 };
        byControl.set(c, entry);
        if (auto) entry.automated.add(ref.p);
        else entry.manual++;
      }
      if (auto) automatedIds.add(ref.p);
      else manualIds.add(ref.p);
    }

    const families = new Map<string, FamilyCoverage>();
    const counts = emptyCounts();
    let outOfBaseline = 0;
    const pimControls = new Set(pimOn ? (PIM_CONTROLS[f.key] ?? []).map((c) => c.id) : []);
    for (const [id, entry] of [...byControl].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))) {
      if (!controlInScope(f, id)) {
        outOfBaseline++;
        continue;
      }
      const automated = [...entry.automated];
      const enforcedBy = [...new Set(automated.flatMap((p) => enforcingPlacements.get(p) ?? []))];
      const pim = pimControls.has(id);
      const status: ControlStatus = enforcedBy.length
        ? 'enforced'
        : automated.length
          ? 'audited'
          : pim
            ? 'pim'
            : entry.manual
              ? input.excludeManualControls
                ? 'excluded'
                : 'manual'
              : 'none';
      const exceptions = [...new Set(automated.flatMap((p) => [...(exceptionsByPolicy.get(p) ?? [])]))];
      const fam = familyOf(f.key, id, catalog.nist.families);
      if (!families.has(fam.code)) families.set(fam.code, { code: fam.code, title: fam.title, controls: [], counts: emptyCounts() });
      const family = families.get(fam.code)!;
      const title = /^[A-Z]{2}-\d/.test(id) ? catalog.nist.controls[id]?.t : undefined;
      family.controls.push({ id, title, status, automated, manual: entry.manual, enforcedBy, exceptions, pim });
      family.counts[status]++;
      counts[status]++;
    }
    const familyList = [...families.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
    const scope = (mgs.flatMap((m) => m.assignments.map((a) => [m.role, a] as const)).find(([, a]) => a.frameworkKey === f.key)?.[0] ??
      'root') as MgRole;
    return {
      key: f.key,
      short: f.short,
      name: f.name,
      framework: f,
      scope,
      inScope: familyList.reduce((n, fam) => n + fam.controls.length, 0),
      partial: familyList.reduce((n, fam) => n + fam.controls.filter((c) => c.exceptions.length).length, 0),
      outOfBaseline,
      counts,
      families: familyList,
      automatedPolicies: automatedIds.size,
      manualPolicies: manualIds.size,
    };
  });

  // --- Policy rows ---------------------------------------------------------

  const rows = new Map<string, PolicyRow>();
  const row = (id: string) => {
    if (!rows.has(id)) rows.set(id, { id, frameworks: [], placements: [] });
    return rows.get(id)!;
  };
  for (const f of frameworks) {
    const controls = new Map<string, Set<string>>();
    for (const ref of f.refs) {
      if (!isAutomated(catalog.policies[ref.p], ref.e) || (gov && catalog.policies[ref.p]?.ng)) continue;
      const inScope = ref.g.filter((c) => controlInScope(f, c));
      if (!inScope.length) continue;
      if (!controls.has(ref.p)) controls.set(ref.p, new Set());
      for (const c of inScope) controls.get(ref.p)!.add(c);
    }
    for (const [p, cs] of controls) row(p).frameworks.push({ key: f.key, controls: [...cs] });
  }
  for (const mg of mgs)
    for (const a of mg.assignments)
      for (const m of a.policies) {
        if (a.origin === 'framework' && !rows.has(m.p)) continue; // manual / out-of-baseline refs
        row(m.p).placements.push({ mg: mg.role, assignment: a.name, effect: m.e, enforced: a.enforcementMode === 'Default' });
      }

  // --- Notes ---------------------------------------------------------------

  for (let i = 0; i < frameworks.length; i++)
    for (let j = i + 1; j < frameworks.length; j++) {
      const a = new Set(frameworks[i].refs.filter((r) => isAutomated(catalog.policies[r.p], r.e)).map((r) => r.p));
      const b = new Set(frameworks[j].refs.filter((r) => isAutomated(catalog.policies[r.p], r.e)).map((r) => r.p));
      const shared = [...a].filter((p) => b.has(p)).length;
      const overlap = shared / Math.min(a.size, b.size || 1);
      if (overlap >= 0.8)
        notes.push({
          level: 'info',
          text: `${frameworks[i].short} and ${frameworks[j].short} share ${Math.round(overlap * 100)}% of their automated policies; both dashboards evaluate the same resources, so assigning both adds little beyond reporting.`,
        });
    }
  for (const mg of mgs)
    for (const a of mg.assignments)
      if (a.name.length > 24) notes.push({ level: 'warning', text: `Assignment name ${a.name} is longer than 24 characters.` });
  if (!frameworks.length) notes.push({ level: 'info', text: 'Select a framework to add compliance auditing and see control coverage.' });
  if (input.enforcement === 'audit')
    notes.push({
      level: 'info',
      text: 'Audit-first posture: Deny guardrails run in DoNotEnforce. DeployIfNotExists and Modify assignments still remediate.',
    });
  const nist = frameworks.find((f) => f.nist);
  if (nist && input.nistBaseline !== 'all')
    notes.push({
      level: 'info',
      text: `The built-in ${nist.name} initiative maps every control. The ${input.nistBaseline} baseline${input.nistPrivacy ? ' (with privacy)' : ''} narrows coverage and enforcement candidates; the compliance dashboard still lists all controls.`,
    });

  if (gov && locations.some((l) => !GOV_LOCATIONS.includes(l)))
    notes.push({ level: 'warning', text: `Not Azure Government regions: ${locations.filter((l) => !GOV_LOCATIONS.includes(l)).join(', ')}.` });
  const overridden = mgs.reduce((n, m) => n + m.assignments.filter((a) => a.overridden).length + m.removed.length, 0);
  const exempted = mgs.reduce((n, m) => n + m.assignments.reduce((k, a) => k + a.exemptions.length, 0), 0);
  if (overridden || exempted)
    notes.push({
      level: 'info',
      text: `${overridden} assignment override${overridden === 1 ? '' : 's'} and ${exempted} exemption${exempted === 1 ? '' : 's'}. Control coverage counts enforcement modes and removals, not excluded scopes or exemptions.`,
    });

  const customRoles: CustomRole[] = input.alzCustomRoles
    ? (catalog.alz.roles ?? []).map((r) => ({
        key: `alz:${r.name}`,
        name: r.name,
        description: r.description,
        roleDefinitionId: uuidv5(`${root.id}/${r.name}`),
      }))
    : [];
  const pim = buildPim(
    input.pim ?? DEFAULT_PIM,
    frameworks.filter((f) => assigned.has(f.key)),
    input.nistBaseline,
    new Set(mgs.map((m) => m.role)),
    customRoles,
  );

  const allAssignments = mgs.flatMap((m) => m.assignments);
  const assignedPolicies = new Set(allAssignments.flatMap((a) => a.policies.map((m) => m.p)));
  return {
    input,
    mgs: MG_ORDER.flatMap((r) => mgByRole.get(r) ?? []),
    coverage,
    policies: [...rows.values()],
    notes,
    pim,
    customRoles,
    stats: {
      managementGroups: mgs.length,
      assignments: allAssignments.length,
      uniquePolicies: assignedPolicies.size,
      enforcingAssignments: allAssignments.filter(
        (a) => a.enforcementMode === 'Default' && a.policies.some((m) => ENFORCING_EFFECTS.has(m.e)),
      ).length,
      frameworkPolicies: [...rows.values()].filter((r) => r.frameworks.length).length,
    },
  };
}

function emptyCounts(): Record<ControlStatus, number> {
  return { enforced: 0, audited: 0, pim: 0, manual: 0, excluded: 0, none: 0 };
}

/** Assignments that apply at a management group: its own plus those inherited from ancestors. */
export function effectiveAssignments(design: Design, role: MgRole): { mg: PlannedMg; assignment: PlannedAssignment }[] {
  const byRole = new Map(design.mgs.map((m) => [m.role, m]));
  const chain: PlannedMg[] = [];
  for (let r: MgRole | null = role; r; r = byRole.get(r)?.parent ?? null) chain.unshift(byRole.get(r)!);
  return chain.flatMap((mg) => mg.assignments.map((assignment) => ({ mg, assignment })));
}
