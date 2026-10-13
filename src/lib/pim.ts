// Privileged Identity Management (PIM) for Azure resource roles: who can be
// made eligible for which privileged role at which management group, and the
// role settings (activation, approval, MFA, expiry) every management group
// applies, from a compliance profile chosen by the selected frameworks.
//
// PIM needs Microsoft Entra ID P2 (or Entra ID Governance) licences.

import type { MgRole } from './engine';

export type PimRoleKey = 'owner' | 'userAccessAdministrator' | 'rbacAdministrator' | 'contributor';

export interface PimRole {
  key: PimRoleKey;
  name: string;
  /** Built-in role definition GUID. */
  roleDefinitionId: string;
  /** Grants access to others, so approval is required in every profile. */
  grantsAccess: boolean;
}

export const PIM_ROLES: PimRole[] = [
  { key: 'owner', name: 'Owner', roleDefinitionId: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', grantsAccess: true },
  { key: 'userAccessAdministrator', name: 'User Access Administrator', roleDefinitionId: '18d7d88d-d35e-4fb5-a5c3-7773c2a72d9d', grantsAccess: true },
  { key: 'rbacAdministrator', name: 'Role Based Access Control Administrator', roleDefinitionId: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168', grantsAccess: true },
  { key: 'contributor', name: 'Contributor', roleDefinitionId: 'b24988ac-6180-42a0-ab88-20f7382dd24c', grantsAccess: false },
];

export type PimProfile = 'standard' | 'high';

/** An eligible assignment: a group that can activate a role at a management group. */
export interface PimEligibility {
  id: string;
  /** What the group is, e.g. "Platform owners"; its object ID is a per-environment value. */
  label: string;
  role: PimRoleKey;
  mg: MgRole;
}

export interface PimInput {
  enabled: boolean;
  /** "auto" picks the profile from the selected frameworks. */
  profile: 'auto' | PimProfile;
  roles: PimRoleKey[];
  eligibilities: PimEligibility[];
}

export const DEFAULT_PIM: PimInput = {
  enabled: true,
  profile: 'auto',
  roles: PIM_ROLES.map((r) => r.key),
  eligibilities: [
    { id: 'platform-owners', label: 'Platform owners', role: 'owner', mg: 'root' },
    { id: 'access-administrators', label: 'Access administrators', role: 'userAccessAdministrator', mg: 'root' },
    { id: 'landing-zone-contributors', label: 'Landing zone contributors', role: 'contributor', mg: 'landingzones' },
  ],
};

export interface PimSettings {
  /** Longest activation, ISO 8601 (PT4H). */
  activationMaximumDuration: string;
  requireMfa: boolean;
  requireJustification: boolean;
  requireTicket: boolean;
  /** Roles whose activation needs approval. */
  approvalRoles: PimRoleKey[];
  /** Eligible assignments expire after (P180D); permanent eligibility isn't allowed. */
  eligibleExpireAfter: string;
  /** Active assignments expire after (P15D); permanent active assignments aren't allowed. */
  activeExpireAfter: string;
  /** How often access reviews should recertify eligible assignments (set up in Entra ID). */
  accessReview: 'monthly' | 'quarterly';
}

export const PROFILE_SETTINGS: Record<PimProfile, PimSettings> = {
  standard: {
    activationMaximumDuration: 'PT8H',
    requireMfa: true,
    requireJustification: true,
    requireTicket: false,
    approvalRoles: PIM_ROLES.filter((r) => r.grantsAccess).map((r) => r.key),
    eligibleExpireAfter: 'P365D',
    activeExpireAfter: 'P15D',
    accessReview: 'quarterly',
  },
  high: {
    activationMaximumDuration: 'PT4H',
    requireMfa: true,
    requireJustification: true,
    requireTicket: true,
    approvalRoles: PIM_ROLES.map((r) => r.key),
    eligibleExpireAfter: 'P180D',
    activeExpireAfter: 'P15D',
    accessReview: 'monthly',
  },
};

/** Frameworks (and the NIST 800-53 High baseline) that call for the high profile. */
const HIGH_FRAMEWORKS = ['fedramp-high', 'cmmc-2-l2', 'cjis'];

export function pimProfileFor(frameworks: string[], nistBaseline: string): { profile: PimProfile; reason: string } {
  const high = frameworks.filter((f) => HIGH_FRAMEWORKS.includes(f));
  if (frameworks.includes('nist-800-53-r5') && (nistBaseline === 'high' || nistBaseline === 'all')) high.push('NIST 800-53 High');
  return high.length
    ? { profile: 'high', reason: `High, for ${high.map((f) => FRAMEWORK_LABEL[f] ?? f).join(', ')}` }
    : { profile: 'standard', reason: 'Standard: no high-impact framework is selected' };
}

const FRAMEWORK_LABEL: Record<string, string> = { 'fedramp-high': 'FedRAMP High', 'cmmc-2-l2': 'CMMC 2.0 L2', cjis: 'CJIS' };

/** Controls PIM helps address, by framework key: just-in-time privilege, MFA, approval, expiry, audit and review. */
export const PIM_CONTROLS: Record<string, { id: string; text: string }[]> = {
  'nist-800-53-r5': [
    { id: 'AC-2(6)', text: 'Dynamic privilege management: privileges are activated just in time and expire.' },
    { id: 'AC-2(7)', text: 'Privileged user accounts: privileged roles are held by named groups, activated per use.' },
    { id: 'AC-6(5)', text: 'Privileged accounts: Owner and access-granting roles are restricted to eligible groups.' },
    { id: 'AC-6(7)', text: 'Review of user privileges: eligible assignments expire and are recertified by access reviews.' },
    { id: 'IA-2(1)', text: 'Multi-factor authentication to privileged accounts: activation requires MFA.' },
    { id: 'AC-2(4)', text: 'Automated audit actions: every activation and approval is logged in PIM and the Entra audit log.' },
  ],
  'nist-800-171-r2': [
    { id: '3.1.5', text: 'Least privilege, including for privileged accounts.' },
    { id: '3.1.7', text: 'Prevent non-privileged users from executing privileged functions; audit their use.' },
    { id: '3.5.3', text: 'Multi-factor authentication for privileged accounts.' },
  ],
  'cmmc-2-l2': [
    { id: 'AC.L2-3.1.5', text: 'Least privilege for privileged accounts.' },
    { id: 'AC.L2-3.1.7', text: 'Privileged functions limited and audited.' },
    { id: 'IA.L2-3.5.3', text: 'Multi-factor authentication for privileged access.' },
  ],
  mcsb: [
    { id: 'PA-1', text: 'Separate and limit highly privileged users.' },
    { id: 'PA-2', text: 'Avoid standing access: just-in-time activation.' },
    { id: 'PA-4', text: 'Review and reconcile user access regularly.' },
  ],
  'iso-27001-2022': [
    { id: 'A.5.18', text: 'Access rights: provisioned, reviewed and removed.' },
    { id: 'A.8.2', text: 'Privileged access rights: restricted and managed.' },
  ],
  'pci-dss-4': [
    { id: '7.2', text: 'Access is assigned by least privilege and reviewed.' },
    { id: '8.4', text: 'Multi-factor authentication for administrative access.' },
  ],
  soc2: [
    { id: 'CC6.1', text: 'Logical access to protected assets is restricted.' },
    { id: 'CC6.3', text: 'Access is authorized, modified and removed based on roles.' },
  ],
};
PIM_CONTROLS['fedramp-high'] = PIM_CONTROLS['nist-800-53-r5'];
PIM_CONTROLS['fedramp-moderate'] = PIM_CONTROLS['nist-800-53-r5'];

/** The design's PIM: settings, roles and eligible assignments that are in the hierarchy. */
export interface PimDesign {
  profile: PimProfile;
  /** Why this profile ("High, for FedRAMP High"). */
  reason: string;
  settings: PimSettings;
  roles: (PimRole & { requireApproval: boolean })[];
  eligibilities: PimEligibility[];
  /** Controls it helps address, per selected framework. */
  controls: { framework: string; controls: { id: string; text: string }[] }[];
}

export function buildPim(
  pim: PimInput,
  frameworks: { key: string; short: string }[],
  nistBaseline: string,
  roles: Set<MgRole>,
): PimDesign | null {
  if (!pim.enabled) return null;
  const auto = pimProfileFor(
    frameworks.map((f) => f.key),
    nistBaseline,
  );
  const profile = pim.profile === 'auto' ? auto.profile : pim.profile;
  const settings = PROFILE_SETTINGS[profile];
  return {
    profile,
    reason: pim.profile === 'auto' ? auto.reason : `${profile === 'high' ? 'High' : 'Standard'} (chosen)`,
    settings,
    roles: PIM_ROLES.filter((r) => pim.roles.includes(r.key)).map((r) => ({ ...r, requireApproval: settings.approvalRoles.includes(r.key) })),
    eligibilities: pim.eligibilities.filter((e) => roles.has(e.mg) && pim.roles.includes(e.role)),
    controls: frameworks.filter((f) => PIM_CONTROLS[f.key]).map((f) => ({ framework: f.short, controls: PIM_CONTROLS[f.key] })),
  };
}
