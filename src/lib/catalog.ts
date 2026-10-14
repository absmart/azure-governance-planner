// Types for src/data/catalog.json, the committed snapshot written by
// scripts/update-catalog.mjs. Keys are short because the file ships to the browser.

export interface PolicyInfo {
  /** Display name. */
  n: string;
  /** Category. */
  c: string;
  /** Default effect of the definition. */
  e: string;
  /** Allowed effects. */
  a: string[];
  /** Description (truncated). */
  d: string;
  /** Version. */
  v: string;
  /** BuiltIn or ALZ custom definition. */
  t: 'BuiltIn' | 'ALZ';
  /** Role definition GUIDs a DeployIfNotExists / Modify identity needs. */
  r?: string[];
  /** Preview. */
  pv?: true;
  /** Deprecated. */
  dp?: true;
  /** A built-in Azure Government doesn't have (per AzAdvertizer). */
  ng?: true;
}

export interface FrameworkRef {
  /** Policy definition GUID. */
  p: string;
  /** Effect the initiative applies by default. */
  e: string;
  /** Controls the policy is mapped to. */
  g: string[];
  /** policyDefinitionReferenceId in the initiative. */
  r?: string;
}

export interface Framework {
  key: string;
  short: string;
  group: string;
  /** Built-in initiative (policy set definition) GUID. */
  id: string;
  name: string;
  description: string;
  version: string;
  /** Whether the initiative is available in Azure Government. */
  usGov?: boolean;
  /** True for NIST SP 800-53 Rev. 5, which supports the SP 800-53B baselines. */
  nist: boolean;
  controls: string[];
  refs: FrameworkRef[];
  source: string;
}

/** A policy in an initiative and the effect it runs with there. */
export interface Member {
  p: string;
  e: string;
  /** policyDefinitionReferenceIds it is included under, for exemptions. */
  r?: string[];
  /** The initiative parameter its effect is wired to (ALZ initiatives), when there is one. */
  ep?: string;
}

export interface ExtraInitiative {
  id: string;
  name: string;
  description: string;
  version: string;
  usGov?: boolean;
  policies: Member[];
}

export interface AlzAssignment {
  displayName: string;
  description: string;
  definitionId: string;
  definitionName: string | null;
  kind: 'policy' | 'initiative';
  source: 'BuiltIn' | 'ALZ';
  enforcementMode: 'Default' | 'DoNotEnforce';
  effect?: string;
  identity: boolean;
  policies: Member[];
  /** False when its built-in definition isn't in Azure Government. */
  usGov?: false;
}

export interface AlzManagementGroup {
  id: string;
  displayName: string;
  parent: string | null;
  archetype: string;
}

/** L/M/H = SP 800-53B Low/Moderate/High baselines, P = privacy baseline. */
export type BaselineCode = 'L' | 'M' | 'H' | 'P';

export interface Catalog {
  generated: string;
  sources: Record<string, string>;
  frameworks: Framework[];
  initiatives: Record<string, ExtraInitiative>;
  nist: {
    families: Record<string, string>;
    controls: Record<string, { t: string; b: BaselineCode[] }>;
  };
  alz: {
    /** ALZ library release the archetypes and assignments come from. */
    ref: string;
    /** ALZ custom roles (permissions are in public/alz-library.json). */
    roles: { name: string; description: string }[];
    managementGroups: AlzManagementGroup[];
    archetypes: Record<string, string[]>;
    assignments: Record<string, AlzAssignment>;
  };
  policies: Record<string, PolicyInfo>;
}

export const BUILTIN_POLICY = {
  allowedLocations: 'e56962a6-4747-49cd-b67b-bf8b01975c4c',
  allowedLocationsRg: 'e765b5de-1225-4ba3-bd56-1ac6695af988',
  requireTagRg: '96670d01-0a4d-4649-9c89-2d3abc0a5025',
  inheritTag: '726aca4c-86e9-4b04-b0c5-073027359532',
  allowedResourceTypes: 'a08ec900-254a-4555-9bf5-e42af04b5c5c',
} as const;

export const portalPolicyUrl = (id: string) => `https://www.azadvertizer.net/azpolicyadvertizer/${id}.html`;
export const portalInitiativeUrl = (id: string) => `https://www.azadvertizer.net/azpolicyinitiativesadvertizer/${id}.html`;

/** Manual attestation policies (effect Manual) can't evaluate resources. */
export function isAutomated(p: PolicyInfo | undefined, effect?: string): boolean {
  if (!p) return false;
  return (effect ?? p.e) !== 'Manual' && p.e !== 'Manual';
}

export function canDeny(p: PolicyInfo | undefined): boolean {
  return !!p && p.a.some((e) => e === 'Deny');
}
