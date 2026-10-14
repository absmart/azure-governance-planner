// Infrastructure-as-code export of a design. Each format has three parts:
//
//   - a generic template (main.bicep / main.tf) that creates management
//     groups, custom policy definitions, assignments and the role assignments
//     their managed identities need, from data. Nothing about the design is
//     hard-coded, so the same template deploys any design;
//   - the design as data (JSON): the hierarchy, the ALZ custom definitions the
//     design uses, from the pinned ALZ library release, and every assignment;
//   - a small per-environment values file: the region and the resource IDs
//     ALZ's DeployIfNotExists policies point at (Log Analytics workspace, DDoS
//     plan, private DNS zones, ...).
//
// All three formats come from the same model, so they always deploy the same design.

import type { Catalog } from './catalog';
import { govZoneName } from './cloud';
import { PARKING_LOT_ALLOWED_TYPES, PARKING_LOT_POLICY, type Design, type PlannedAssignment, type ScopeRef } from './engine';
import { resourceName } from './naming';
import { privateDnsZones } from './privateDns';

export type IacFormat = 'bicep' | 'terraform' | 'terragrunt';

export const FORMAT_LABEL: Record<IacFormat, string> = { bicep: 'Bicep', terraform: 'Terraform', terragrunt: 'Terragrunt' };

export const EXPORT_ROOT: Record<IacFormat, string> = {
  bicep: 'governance-bicep',
  terraform: 'governance-terraform',
  terragrunt: 'governance-terragrunt',
};

export interface IacFile {
  name: string;
  content: string;
  /** What the file is for, shown next to its name. */
  description: string;
}

// --- ALZ library (public/alz-library.json) -----------------------------------

export interface ArmDefinition {
  name: string;
  properties: Record<string, unknown> & {
    displayName?: string;
    description?: string;
    mode?: string;
    metadata?: unknown;
    parameters?: Record<string, unknown>;
    policyRule?: { then?: { details?: { roleDefinitionIds?: string[] }; [key: string]: unknown }; [key: string]: unknown };
    policyDefinitions?: SetReference[];
    policyDefinitionGroups?: { name: string; displayName?: string; category?: string; description?: string }[];
  };
}

interface SetReference {
  policyDefinitionId: string;
  policyDefinitionReferenceId?: string;
  parameters?: Record<string, unknown>;
  groupNames?: string[];
  definitionVersion?: string;
}

interface NonComplianceMessage {
  message: string;
  policyDefinitionReferenceId?: string;
}

export interface AlzLibrary {
  ref: string;
  policyDefinitions: Record<string, ArmDefinition>;
  policySetDefinitions: Record<string, ArmDefinition>;
  policyAssignments: Record<
    string,
    { parameters: Record<string, { value: unknown }>; nonComplianceMessages: NonComplianceMessage[]; definitionVersion?: string }
  >;
  defaults: { default_name: string; description: string; policy_assignments: { policy_assignment_name: string; parameter_names: string[] }[] }[];
  /** ALZ custom roles by role name. */
  roleDefinitions?: Record<string, { description: string; permissions: Partial<RolePermissions>[] }>;
}

export interface RolePermissions {
  actions: string[];
  notActions: string[];
  dataActions: string[];
  notDataActions: string[];
}

/** A custom role defined at the top management group. */
export interface IacRoleDefinition {
  /** The role definition's GUID. */
  name: string;
  roleName: string;
  description: string;
  permissions: RolePermissions[];
}

// --- Model -------------------------------------------------------------------

/** A per-environment value: the region, or an ALZ policy default value. */
export interface IacInput {
  name: string;
  description: string;
  /** The ALZ library's placeholder (or a sensible default). */
  placeholder: string;
  /** Assignments that use it. */
  usedBy: string[];
}

export interface IacManagementGroup {
  id: string;
  displayName: string;
  /** Null for the top of the hierarchy, created under the tenant root group (or a given parent). */
  parentId: string | null;
}

export interface IacAssignment {
  managementGroupId: string;
  name: string;
  displayName: string;
  description: string;
  policyDefinitionId: string;
  definitionVersion?: string;
  enforcementMode: 'Default' | 'DoNotEnforce';
  identity: boolean;
  /** Fixed parameter values, as ARM expects them: { name: { value } }. */
  parameters: Record<string, { value: unknown }>;
  /** Parameters set from per-environment inputs: { parameter: input name }. */
  inputs: Record<string, string>;
  nonComplianceMessages: NonComplianceMessage[];
  /** Roles the assignment's identity gets at its management group, so remediation can deploy and modify. */
  roleDefinitionIds: string[];
  /** Resource IDs the assignment doesn't apply to. */
  notScopes: string[];
  /** Reference IDs of the initiative's manual-attestation policies (effect Manual). */
  manualReferenceIds: string[];
}

export interface IacPim {
  profile: 'standard' | 'high';
  activationMaximumDuration: string;
  requireMfa: boolean;
  requireJustification: boolean;
  requireTicket: boolean;
  eligibleExpireAfter: string;
  activeExpireAfter: string;
  /** Length of the eligible assignments the export makes, in days (within eligibleExpireAfter). */
  eligibleDurationDays: number;
  accessReview: 'monthly' | 'quarterly';
  /** Management groups whose role settings are set. */
  managementGroupIds: string[];
  roles: { name: string; roleDefinitionId: string; requireApproval: boolean }[];
  eligibilities: { name: string; roleName: string; roleDefinitionId: string; managementGroupId: string; input: string }[];
}

/** A policy exemption, at a management group, subscription or resource group. */
export interface IacExemption {
  name: string;
  displayName: string;
  description: string;
  /** The exempted assignment: its management group and name. */
  managementGroupId: string;
  assignment: string;
  scope:
    | { kind: 'managementGroup'; managementGroupId: string }
    | { kind: 'subscription'; subscriptionId: string }
    | { kind: 'resourceGroup'; subscriptionId: string; resourceGroupName: string };
  /** policyDefinitionReferenceIds; empty for the whole assignment. */
  policyDefinitionReferenceIds: string[];
  category: 'Waiver' | 'Mitigated';
  /** ISO date-time, or null. */
  expiresOn: string | null;
}

export type DataCollectionRule = 'vmInsights' | 'changeTracking' | 'defenderSql';

/** Platform resources the templates create for ALZ's DeployIfNotExists policies to point at. */
export interface PlatformResources {
  /** In the management subscription: a resource group with these. */
  logAnalyticsWorkspace: boolean;
  /** The user-assigned identity Azure Monitor Agent authenticates with. */
  userAssignedIdentity: boolean;
  dataCollectionRules: DataCollectionRule[];
  /** In the connectivity subscription: the resource group for the private DNS zones. */
  privateDnsResourceGroup: boolean;
  /** Zones created in it; regional names carry {regionName}, filled in from the private DNS zone region. */
  privateDnsZones: string[];
}

/**
 * A role a remediation identity needs on a resource its parameters point at,
 * outside its own management group (ALZ grants these too).
 */
export interface PlatformRoleAssignment {
  managementGroupId: string;
  assignment: string;
  roleDefinitionId: string;
  /** "management" or "privateDns" resource group, or the input holding a resource ID (its resource group). */
  scope: string;
}

/** A subscription moved into a management group, so the group's policy assignments apply to it. */
export interface SubscriptionPlacement {
  managementGroupId: string;
  /** Input holding the subscription ID. */
  input: string;
}

export interface IacModel {
  rootName: string;
  alzRef: string;
  managementGroups: IacManagementGroup[];
  policyDefinitions: ArmDefinition[];
  policySetDefinitions: ArmDefinition[];
  assignments: IacAssignment[];
  platform: PlatformResources;
  platformRoleAssignments: PlatformRoleAssignment[];
  /**
   * Tenant hierarchy settings: the management group new subscriptions land in
   * (the parking lot) and whether creating management groups needs permission.
   */
  hierarchySettings: { defaultManagementGroupId: string; requireAuthorizationForGroupCreation: boolean } | null;
  /** Privileged Identity Management: role settings at every management group, and eligible assignments. */
  pim: IacPim | null;
  /** ALZ custom roles, defined at the top management group. */
  roleDefinitions: IacRoleDefinition[];
  /** "public" or "usgovernment" (the Terraform provider's environment). */
  cloud: 'public' | 'usgovernment';
  exemptions: IacExemption[];
  /** Platform subscriptions to place in their management groups (when the export option is on). */
  subscriptionPlacements: SubscriptionPlacement[];
  inputs: IacInput[];
  /**
   * Values the templates read under another input's name: with a single platform
   * subscription, management_subscription_id and private_dns_zone_subscription_id
   * are both platform_subscription_id.
   */
  aliases: Record<string, string>;
  /** Things the export changed or left out. */
  notes: string[];
}

/** ALZ inputs the templates fill with the platform resources they create. */
const CREATED_INPUTS: Record<string, { creates: keyof PlatformResources; rule?: DataCollectionRule }> = {
  log_analytics_workspace_id: { creates: 'logAnalyticsWorkspace' },
  ama_user_assigned_managed_identity_id: { creates: 'userAssignedIdentity' },
  ama_vm_insights_data_collection_rule_id: { creates: 'dataCollectionRules', rule: 'vmInsights' },
  ama_change_tracking_data_collection_rule_id: { creates: 'dataCollectionRules', rule: 'changeTracking' },
  ama_mdfc_sql_data_collection_rule_id: { creates: 'dataCollectionRules', rule: 'defenderSql' },
};

const RULE_NAME_INPUT: Record<DataCollectionRule, string> = {
  vmInsights: 'vm_insights_data_collection_rule_name',
  changeTracking: 'change_tracking_data_collection_rule_name',
  defenderSql: 'defender_sql_data_collection_rule_name',
};

const ENVIRONMENT_TOKEN = '{environment}';
const REGION_TOKEN = '{region}';

/**
 * Default resource names, <app>-<environment>-<region>-<int>-<type>. The
 * environment and region are filled in from the export's environment and
 * location, so the defaults follow them.
 */
const NAME_DEFAULTS: Record<string, string> = Object.fromEntries(
  (
    [
      ['management_resource_group_name', 'management', 'rg'],
      ['log_analytics_workspace_name', 'management', 'log'],
      ['ama_user_assigned_managed_identity_name', 'ama', 'id'],
      ['vm_insights_data_collection_rule_name', 'vminsights', 'dcr'],
      ['change_tracking_data_collection_rule_name', 'changetracking', 'dcr'],
      ['defender_sql_data_collection_rule_name', 'defendersql', 'dcr'],
      ['private_dns_zone_resource_group_name', 'privatedns', 'rg'],
      // Resource groups ALZ's DeployIfNotExists policies create in each subscription.
      ['resource_group_name_mdfc', 'mdfcexport', 'rg'],
      ['resource_group_name_service_health_alerts', 'servicehealth', 'rg'],
    ] as const
  ).map(([input, app, type]) => [input, `${app}-${ENVIRONMENT_TOKEN}-${REGION_TOKEN}-01-${type}`]),
);

const PRIVATE_DNS_INPUTS = new Set(['private_dns_zone_subscription_id', 'private_dns_zone_resource_group_name']);

/** Inputs holding a resource ID the export doesn't create; identities get their roles on its resource group. */
const RESOURCE_ID_INPUTS = new Set(['ddos_protection_plan_id']);

const NEW_INPUT_DESCRIPTION: Record<string, string> = {
  management_subscription_id: 'The management subscription, for the Log Analytics workspace, data collection rules and AMA identity.',
  platform_subscription_id:
    'The single platform subscription (connectivity, identity, management and security together): the management resources and private DNS zones go here, and it is placed in the Platform management group.',
  management_resource_group_name: 'Resource group created in the management subscription for those resources.',
  log_analytics_workspace_name: 'Name of the Log Analytics workspace created in the management resource group.',
  ama_user_assigned_managed_identity_name: 'Name of the user-assigned identity Azure Monitor Agent authenticates with (created in the management resource group).',
  vm_insights_data_collection_rule_name: 'Name of the VM Insights data collection rule.',
  change_tracking_data_collection_rule_name: 'Name of the Change Tracking and Inventory data collection rule.',
  defender_sql_data_collection_rule_name: 'Name of the Defender for SQL data collection rule.',
  private_dns_zone_resource_group_name: 'Resource group created in the private DNS zone subscription for the private link DNS zones.',
  pim_approver_group_id: 'Object ID of the Entra ID group that approves privileged role activations (PIM). Without it, activations need no approval.',
};

/** The export dialog's settings: the format plus the options. */
export interface ExportSettings extends ExportOptions {
  format: IacFormat;
}

export interface ExportOptions {
  environment: string;
  /** Values for the model's inputs, by name; empty or missing means the placeholder. */
  values: Record<string, string>;
  /** Move the platform subscriptions into their management groups (default true). */
  placeSubscriptions?: boolean;
  /**
   * Turn off the manual-attestation policies in the initiatives (assignment
   * overrides, effect Disabled), so controls with only manual policies drop out.
   */
  excludeManualControls?: boolean;
}

const MG_SCOPED_DEFINITION = /^\/providers\/Microsoft\.Management\/managementGroups\/[^/]+\/providers\/Microsoft\.Authorization\//i;
const PLACEHOLDER = /placeholder|00000000-0000-0000-0000-000000000000|\$\{default_location\}/i;
const LOCATION_TOKEN = '${default_location}';

const lastSegment = (id: string) => id.split('/').pop()!;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Builds the deployment model of a design: everything the templates create, in dependency order. */
export function buildIacModel(design: Design, catalog: Catalog, library: AlzLibrary): IacModel {
  const notes: string[] = [];
  const root = design.mgs[0];
  const mgById = new Map(design.mgs.map((m) => [m.role, m]));
  const atRoot = (id: string) =>
    id.replace(MG_SCOPED_DEFINITION, `/providers/Microsoft.Management/managementGroups/${root.id}/providers/Microsoft.Authorization/`);

  const mgIdOf = (role: string) => design.mgs.find((m) => m.role === role)?.id ?? role;
  const scopeId = (scope: ScopeRef): string =>
    scope.kind === 'managementGroup'
      ? `/providers/Microsoft.Management/managementGroups/${mgIdOf(scope.role)}`
      : scope.kind === 'subscription'
        ? `/subscriptions/${subscriptionGuid(scope.id)}`
        : scope.id.trim();

  const managementGroups: IacManagementGroup[] = design.mgs.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    parentId: m.parent ? mgById.get(m.parent)!.id : null,
  }));

  // Custom definitions the design's assignments use, from the ALZ library.
  const definitions = new Map<string, ArmDefinition>();
  const sets = new Map<string, ArmDefinition>();
  const missing = new Set<string>();
  const useDefinition = (name: string) => {
    if (definitions.has(name)) return;
    const def = library.policyDefinitions[name];
    if (!def) return void missing.add(name);
    definitions.set(name, clone(def));
  };
  const gov = design.input.cloud === 'AzureUSGovernment';
  let govDropped = 0;
  const useSet = (name: string) => {
    if (sets.has(name)) return;
    const set = library.policySetDefinitions[name];
    if (!set) return void missing.add(name);
    const copy = clone(set);
    for (const ref of copy.properties.policyDefinitions ?? []) {
      if (!MG_SCOPED_DEFINITION.test(ref.policyDefinitionId)) continue;
      ref.policyDefinitionId = atRoot(ref.policyDefinitionId);
      useDefinition(lastSegment(ref.policyDefinitionId));
    }
    if (gov) {
      const refs = copy.properties.policyDefinitions ?? [];
      copy.properties.policyDefinitions = refs.filter(
        (ref) => MG_SCOPED_DEFINITION.test(ref.policyDefinitionId) || !catalog.policies[lastSegment(ref.policyDefinitionId)]?.ng,
      );
      govDropped += refs.length - copy.properties.policyDefinitions.length;
    }
    sets.set(name, copy);
  };

  const inputUse = new Map<string, Set<string>>();
  const useInput = (input: string, assignment: string) => {
    if (!inputUse.has(input)) inputUse.set(input, new Set());
    inputUse.get(input)!.add(assignment);
  };
  const placeholders = new Map<string, string>();
  let droppedPlaceholders = 0;

  const assignments: IacAssignment[] = [];
  for (const mg of design.mgs) {
    for (const a of mg.assignments) {
      const policyDefinitionId = atRoot(a.definitionId);
      if (a.definitionSource === 'ALZ') (a.kind === 'initiative' ? useSet : useDefinition)(lastSegment(policyDefinitionId));
      if (a.definitionSource === 'Custom') {
        if (a.kind === 'initiative') sets.set(a.name, frameworkEnforcementSet(a));
        else if (lastSegment(policyDefinitionId) === PARKING_LOT_POLICY) definitions.set(PARKING_LOT_POLICY, parkingLotDefinition());
      }

      let parameters: Record<string, { value: unknown }> = {};
      const inputs: Record<string, string> = {};
      let nonComplianceMessages: NonComplianceMessage[] = [];
      let definitionVersion: string | undefined;
      const lib = a.origin === 'alz' ? library.policyAssignments[a.name] : undefined;
      if (a.origin === 'alz' && !lib) notes.push(`${a.name}: not in ALZ library ${library.ref}; assigned without parameters.`);
      if (lib) {
        parameters = clone(lib.parameters);
        definitionVersion = lib.definitionVersion;
        // ALZ words its messages with {enforcementMode}: "must" when enforced, "should" when not.
        nonComplianceMessages = lib.nonComplianceMessages.map((m) => ({
          ...m,
          message: m.message.replace(/\{enforcementMode\}/g, a.enforcementMode === 'Default' ? 'must' : 'should'),
        }));
        for (const d of library.defaults)
          for (const target of d.policy_assignments)
            if (target.policy_assignment_name === a.name)
              for (const p of target.parameter_names) {
                const current = parameters[p]?.value;
                if (typeof current === 'string' && !placeholders.has(d.default_name)) placeholders.set(d.default_name, current);
                delete parameters[p];
                inputs[p] = d.default_name;
                useInput(d.default_name, a.name);
              }
        for (const [p, { value }] of Object.entries(parameters)) {
          if (value === LOCATION_TOKEN) {
            delete parameters[p];
            inputs[p] = 'location';
            useInput('location', a.name);
          } else if (PLACEHOLDER.test(JSON.stringify(value))) {
            // e.g. the per-zone private DNS zone IDs, which the initiative builds
            // from the DNS subscription, resource group and region instead.
            delete parameters[p];
            droppedPlaceholders++;
          }
        }
        // Azure Government zone names for ALZ's private DNS policy.
        const dnsZoneNames = library.policySetDefinitions[lastSegment(policyDefinitionId)]?.properties.parameters?.dnsZoneNames as
          | { defaultValue?: Record<string, string> }
          | undefined;
        if (gov && dnsZoneNames?.defaultValue)
          parameters.dnsZoneNames = {
            value: Object.fromEntries(Object.entries(dnsZoneNames.defaultValue).map(([k, z]) => [k, govZoneName(z)])),
          };
        // Parameter overrides replace the library value or input.
        for (const [p, value] of Object.entries(a.parameters ?? {})) {
          delete inputs[p];
          parameters[p] = { value };
        }
      } else if (a.parameters) {
        parameters = Object.fromEntries(Object.entries(a.parameters).map(([k, value]) => [k, { value }]));
      }

      // Messages for policies an Azure Government export left out of the initiative would fail validation.
      const setRefs = sets.get(lastSegment(policyDefinitionId))?.properties.policyDefinitions;
      if (gov && setRefs) {
        const kept = new Set(setRefs.map((r) => r.policyDefinitionReferenceId));
        nonComplianceMessages = nonComplianceMessages.filter((m) => !m.policyDefinitionReferenceId || kept.has(m.policyDefinitionReferenceId));
      }

      assignments.push({
        managementGroupId: mg.id,
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        policyDefinitionId,
        ...(definitionVersion ? { definitionVersion } : {}),
        enforcementMode: a.enforcementMode,
        identity: a.identity,
        parameters,
        inputs,
        nonComplianceMessages,
        roleDefinitionIds: a.identity ? rolesFor(a, catalog, library) : [],
        notScopes: (a.notScopes ?? []).map(scopeId),
        manualReferenceIds:
          a.kind === 'initiative'
            ? [...new Set(a.policies.filter((m) => (m.e || catalog.policies[m.p]?.e) === 'Manual').flatMap((m) => m.r ?? []))]
            : [],
      });
      if (a.identity) useInput('location', a.name);
    }
  }
  if (govDropped)
    notes.push(
      `Azure Government: ${govDropped} references to built-in policies it doesn't have were left out of the ALZ initiatives (availability from AzAdvertizer).`,
    );
  if (missing.size) notes.push(`Not found in ALZ library ${library.ref}: ${[...missing].join(', ')}.`);
  if (droppedPlaceholders)
    notes.push(
      `${droppedPlaceholders} ALZ placeholder parameter values were left out so the definitions' defaults apply (for private DNS, the zone IDs are built from the DNS subscription, resource group and region).`,
    );

  // Platform resources: created for the inputs that would otherwise point at existing ones.
  const platform: PlatformResources = {
    logAnalyticsWorkspace: false,
    userAssignedIdentity: false,
    dataCollectionRules: [],
    privateDnsResourceGroup: false,
    privateDnsZones: [],
  };
  for (const name of inputUse.keys()) {
    const created = CREATED_INPUTS[name];
    if (created?.rule) platform.dataCollectionRules.push(created.rule);
    else if (created) platform[created.creates as 'logAnalyticsWorkspace' | 'userAssignedIdentity'] = true;
    if (PRIVATE_DNS_INPUTS.has(name)) platform.privateDnsResourceGroup = true;
  }
  if (platform.privateDnsResourceGroup)
    platform.privateDnsZones = [
      ...new Set(privateDnsZones(design.input.privateDnsZones ?? [], '{regionName}').map((z) => (gov ? govZoneName(z) : z))),
    ];

  // Exemptions.
  const exemptions: IacExemption[] = [];
  for (const mg of design.mgs)
    for (const a of mg.assignments)
      a.exemptions.forEach((e, i) => {
        const refs = e.policies.length
          ? [...new Set(a.policies.filter((m) => e.policies.includes(m.p)).flatMap((m) => m.r ?? [m.p]))]
          : [];
        const scope: IacExemption['scope'] =
          e.scope.kind === 'managementGroup'
            ? { kind: 'managementGroup', managementGroupId: mgIdOf(e.scope.role) }
            : e.scope.kind === 'subscription'
              ? { kind: 'subscription', subscriptionId: subscriptionGuid(e.scope.id) }
              : {
                  kind: 'resourceGroup',
                  subscriptionId: /\/subscriptions\/([^/]+)/i.exec(e.scope.id)?.[1] ?? '',
                  resourceGroupName: /\/resourceGroups\/([^/]+)/i.exec(e.scope.id)?.[1] ?? '',
                };
        exemptions.push({
          name: `${a.name}-exempt-${String(i + 1).padStart(2, '0')}`.slice(0, 64),
          displayName: `Exempt ${a.name}${refs.length ? ` (${refs.length} polic${refs.length === 1 ? 'y' : 'ies'})` : ''}`,
          description: e.reason,
          managementGroupId: mg.id,
          assignment: a.name,
          scope,
          policyDefinitionReferenceIds: a.kind === 'initiative' ? refs : [],
          category: e.category,
          expiresOn: e.expiresOn ? `${e.expiresOn}T00:00:00Z` : null,
        });
      });
  // Data collection rules send to the workspace.
  if (platform.dataCollectionRules.length) platform.logAnalyticsWorkspace = true;
  platform.dataCollectionRules.sort();
  const management = platform.logAnalyticsWorkspace || platform.userAssignedIdentity;

  // Remediation identities get their roles on the resource groups their parameters point at.
  const platformRoleAssignments: PlatformRoleAssignment[] = [];
  for (const a of assignments) {
    if (!a.identity || !a.roleDefinitionIds.length) continue;
    const scopes = new Set<string>();
    for (const input of Object.values(a.inputs)) {
      if (CREATED_INPUTS[input]) scopes.add('management');
      else if (PRIVATE_DNS_INPUTS.has(input)) scopes.add('privateDns');
      else if (RESOURCE_ID_INPUTS.has(input)) scopes.add(input);
    }
    for (const scope of scopes)
      for (const roleDefinitionId of a.roleDefinitionIds)
        platformRoleAssignments.push({ managementGroupId: a.managementGroupId, assignment: a.name, roleDefinitionId, scope });
  }

  const location = design.input.allowedLocations.map((l) => l.trim()).find(Boolean) ?? 'eastus2';
  if (!inputUse.has('location')) inputUse.set('location', new Set());
  for (const name of Object.keys(CREATED_INPUTS)) inputUse.delete(name);
  if (management)
    for (const name of ['management_subscription_id', 'management_resource_group_name']) inputUse.set(name, new Set());
  // Names of the created resources.
  if (platform.logAnalyticsWorkspace) inputUse.set('log_analytics_workspace_name', new Set());
  if (platform.userAssignedIdentity && !inputUse.has('ama_user_assigned_managed_identity_name'))
    inputUse.set('ama_user_assigned_managed_identity_name', new Set());
  for (const rule of platform.dataCollectionRules) inputUse.set(RULE_NAME_INPUT[rule], new Set());
  // Subscriptions. With a single platform subscription, one value serves them all.
  const single = design.input.platform === 'single';
  const aliases: Record<string, string> = {};
  const subscriptionPlacements: SubscriptionPlacement[] = [];
  const mgOf = (role: string) => design.mgs.find((m) => m.role === role)?.id;
  if (single) {
    for (const name of ['management_subscription_id', 'private_dns_zone_subscription_id'])
      if (inputUse.delete(name)) aliases[name] = 'platform_subscription_id';
    inputUse.set('platform_subscription_id', new Set());
    subscriptionPlacements.push({ managementGroupId: mgOf('platform')!, input: 'platform_subscription_id' });
  } else {
    if (inputUse.has('management_subscription_id') && mgOf('management'))
      subscriptionPlacements.push({ managementGroupId: mgOf('management')!, input: 'management_subscription_id' });
    if (inputUse.has('private_dns_zone_subscription_id') && mgOf('connectivity'))
      subscriptionPlacements.push({ managementGroupId: mgOf('connectivity')!, input: 'private_dns_zone_subscription_id' });
  }

  // PIM: the approver group and each eligible group are per-environment object IDs.
  const pimDesign = design.pim;
  const pimGroupInput = (id: string) => `pim_group_${id.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
  const pimDescriptions = new Map<string, string>();
  let pim: IacPim | null = null;
  if (pimDesign) {
    if (pimDesign.roles.some((r) => r.requireApproval)) inputUse.set('pim_approver_group_id', new Set());
    const eligibilities = pimDesign.eligibilities.map((e) => {
      const role = pimDesign.roles.find((r) => r.key === e.role)!;
      const input = pimGroupInput(e.id);
      inputUse.set(input, new Set());
      pimDescriptions.set(input, `Object ID of the Entra ID group "${e.label}", made eligible for ${role.name} at ${mgIdOf(e.mg)} (PIM).`);
      return { name: e.label, roleName: role.name, roleDefinitionId: role.roleDefinitionId, managementGroupId: mgIdOf(e.mg), input };
    });
    const st = pimDesign.settings;
    pim = {
      profile: pimDesign.profile,
      activationMaximumDuration: st.activationMaximumDuration,
      requireMfa: st.requireMfa,
      requireJustification: st.requireJustification,
      requireTicket: st.requireTicket,
      eligibleExpireAfter: st.eligibleExpireAfter,
      activeExpireAfter: st.activeExpireAfter,
      eligibleDurationDays: Number(/P(\d+)D/.exec(st.eligibleExpireAfter)?.[1] ?? 180),
      accessReview: st.accessReview,
      managementGroupIds: managementGroups.map((m) => m.id),
      roles: pimDesign.roles.map((r) => ({ name: r.name, roleDefinitionId: r.roleDefinitionId, requireApproval: r.requireApproval })),
      eligibilities,
    };
  }

  const describe = new Map(library.defaults.map((d) => [d.default_name, d.description]));
  const defaultValue = (name: string): string => {
    switch (name) {
      case 'location':
      case 'private_dns_zone_region':
        return location;
      case 'management_subscription_id':
      case 'platform_subscription_id':
      case 'pim_approver_group_id':
        return '';
      default:
        if (NAME_DEFAULTS[name]) return NAME_DEFAULTS[name];
        if (name.startsWith('pim_group_')) return '';
        return (placeholders.get(name) ?? '').replace(LOCATION_TOKEN, location);
    }
  };
  const inputs: IacInput[] = [...inputUse].map(([name, users]) => ({
    name,
    description:
      name === 'location'
        ? 'Region for the platform resources, the policy assignments’ managed identities and the resources their remediation deploys.'
        : (NEW_INPUT_DESCRIPTION[name] ?? pimDescriptions.get(name) ?? describe.get(name) ?? name),
    placeholder: defaultValue(name),
    usedBy: [...users],
  }));
  const order = (name: string) =>
    name === 'location' ? 0 : name === 'platform_subscription_id' ? 1 : name.startsWith('management_') ? 2 : 3;
  inputs.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));

  return {
    rootName: root.displayName,
    alzRef: library.ref,
    managementGroups,
    policyDefinitions: [...definitions.values()],
    policySetDefinitions: [...sets.values()],
    assignments,
    platform,
    platformRoleAssignments,
    cloud: gov ? 'usgovernment' : 'public',
    pim,
    roleDefinitions: design.customRoles.map((r) => ({
      name: r.roleDefinitionId,
      roleName: `${r.name} (${root.id})`,
      description: r.description,
      permissions: (library.roleDefinitions?.[r.name]?.permissions ?? []).map((p) => ({
        actions: p.actions ?? [],
        notActions: p.notActions ?? [],
        dataActions: p.dataActions ?? [],
        notDataActions: p.notDataActions ?? [],
      })),
    })),
    hierarchySettings: design.input.parkingLot
      ? {
          defaultManagementGroupId: mgIdOf('parkinglot'),
          requireAuthorizationForGroupCreation: design.input.requireManagementGroupAuthorization,
        }
      : null,
    exemptions,
    subscriptionPlacements,
    inputs,
    aliases,
    notes,
  };
}

/** "11111111-..." from a subscription GUID or "/subscriptions/<guid>[/...]". */
function subscriptionGuid(id: string): string {
  return /\/subscriptions\/([^/]+)/i.exec(id)?.[1] ?? id.trim();
}

/** Deny every resource type (mode All: resource groups and subscription resources too) except a short list. */
function parkingLotDefinition(): ArmDefinition {
  return {
    name: PARKING_LOT_POLICY,
    properties: {
      displayName: 'Deny resources in parking lot subscriptions',
      description:
        'Denies creating or changing any resource, resource group or subscription setting except the allowed resource types, so a subscription in the parking lot can only be moved to its landing zone.',
      policyType: 'Custom',
      mode: 'All',
      metadata: { category: 'General', version: '1.0.0', source: 'Azure Governance Planner' },
      parameters: {
        effect: {
          type: 'String',
          allowedValues: ['Deny', 'Audit', 'Disabled'],
          defaultValue: 'Deny',
          metadata: { displayName: 'Effect' },
        },
        allowedResourceTypes: {
          type: 'Array',
          defaultValue: PARKING_LOT_ALLOWED_TYPES,
          metadata: {
            displayName: 'Allowed resource types',
            description: 'Types still allowed, by default the security baseline the platform deploys (Defender for Cloud, activity log).',
          },
        },
      },
      policyRule: {
        if: { field: 'type', notIn: "[parameters('allowedResourceTypes')]" },
        then: { effect: "[parameters('effect')]" },
      },
    },
  };
}

/** The design's custom initiative of framework policies set to Deny. */
function frameworkEnforcementSet(a: PlannedAssignment): ArmDefinition {
  return {
    name: a.name,
    properties: {
      displayName: a.definitionName,
      description: a.description,
      policyType: 'Custom',
      metadata: { category: 'Regulatory Compliance', source: 'Azure Governance Planner', version: '1.0.0' },
      parameters: {},
      // Every Deny-capable built-in takes its effect as a parameter named "effect".
      policyDefinitions: a.policies.map((m) => ({
        policyDefinitionReferenceId: m.p,
        policyDefinitionId: `/providers/Microsoft.Authorization/policyDefinitions/${m.p}`,
        parameters: { effect: { value: 'Deny' } },
      })),
    },
  };
}

/** Roles the policies of an assignment declare for remediation (as ALZ assigns them). */
function rolesFor(a: PlannedAssignment, catalog: Catalog, library: AlzLibrary): string[] {
  const roles = new Set<string>();
  for (const m of a.policies) {
    const custom = library.policyDefinitions[m.p]?.properties.policyRule?.then?.details?.roleDefinitionIds;
    for (const r of custom?.map((id) => lastSegment(id).toLowerCase()) ?? catalog.policies[m.p]?.r ?? []) roles.add(r);
  }
  return [...roles].sort();
}

/** An input's default for these options: resource names follow the environment and location. */
export function placeholderOf(input: IacInput, model: IacModel, options: ExportOptions): string {
  if (!input.placeholder.includes(ENVIRONMENT_TOKEN)) return input.placeholder;
  const location = model.inputs.find((i) => i.name === 'location');
  const region = (location && (options.values.location?.trim() || location.placeholder)) || 'eastus2';
  const [app, , , instance, type] = input.placeholder.split('-');
  return resourceName(app, options.environment, region, type, instance);
}

/** The value an input deploys with. */
export function inputValue(input: IacInput, model: IacModel, options: ExportOptions): string {
  return options.values[input.name]?.trim() || placeholderOf(input, model, options);
}

/** Inputs still at an ALZ placeholder (or empty), which deploy but point at nothing. */
export function unsetInputs(model: IacModel, options: ExportOptions): IacInput[] {
  return model.inputs.filter((i) => {
    const v = inputValue(i, model, options);
    return !v || PLACEHOLDER.test(v) || /replace_me|^defaultString/i.test(v);
  });
}

// --- Shared ------------------------------------------------------------------

const GENERATOR = 'Generated by Azure Governance Planner.';

function commentBlock(prefix: string, lines: string[]): string {
  return lines.map((l) => (l ? `${prefix} ${l}` : prefix)).join('\n') + '\n';
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** The platform resources for these options: regional zone names for the private DNS zone region. */
function platformFor(model: IacModel, options: ExportOptions): PlatformResources {
  const region = model.inputs.find((i) => i.name === 'private_dns_zone_region');
  const name = (region ? inputValue(region, model, options) : 'eastus2').toLowerCase();
  return { ...model.platform, privateDnsZones: [...new Set(model.platform.privateDnsZones.map((z) => z.replace('{regionName}', name)))] };
}

const environmentOf = (options: ExportOptions) => options.environment.trim().replace(/[^A-Za-z0-9_-]+/g, '-') || 'prd';

/** The platform resources the export creates, in a phrase ("" for none). */
export function platformSummary(model: IacModel): string {
  const { platform } = model;
  const parts = [
    platform.logAnalyticsWorkspace && 'a Log Analytics workspace',
    platform.dataCollectionRules.length &&
      `${platform.dataCollectionRules.length} data collection rule${platform.dataCollectionRules.length > 1 ? 's' : ''}`,
    platform.userAssignedIdentity && 'the Azure Monitor Agent identity',
  ].filter(Boolean) as string[];
  const management = parts.length
    ? `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]} in the management subscription`
    : '';
  const dns = platform.privateDnsResourceGroup
    ? `the private DNS zone resource group${platform.privateDnsZones.length ? ` with ${platform.privateDnsZones.length} private link zones` : ''}`
    : '';
  return [management, dns].filter(Boolean).join(', and ');
}

/** Role assignments the export makes: at management groups, and on platform resource groups. */
export const roleAssignmentCount = (model: IacModel) =>
  model.assignments.reduce((n, a) => n + a.roleDefinitionIds.length, 0) + model.platformRoleAssignments.length;

function summaryLines(model: IacModel): string[] {
  const platform = platformSummary(model);
  return [
    `${model.managementGroups.length} management groups under ${model.rootName}, ${model.policyDefinitions.length} custom policy definitions,`,
    `${model.policySetDefinitions.length} custom initiatives, ${model.assignments.length} policy assignments and`,
    `${roleAssignmentCount(model)} role assignments for their managed identities.`,
    ...(platform ? [`Platform resources: ${platform}.`] : []),
    `ALZ definitions are from the Azure Landing Zones library, ${model.alzRef}.`,
  ];
}

// --- Bicep -------------------------------------------------------------------

const bicepString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$\{/g, '\\${')}'`;

export function toBicep(): string {
  return `${commentBlock('//', [
    'Management groups, custom policy definitions and policy assignments from data.',
    GENERATOR,
    '',
    'Generic: the design comes in as parameters (see the .bicepparam file and lib/),',
    'so the same template deploys any design. Deploy at tenant scope:',
    '  az deployment tenant create --location <region> --parameters <env>.bicepparam',
  ])}
targetScope = 'tenant'

@description('Region of the deployment, the assignments\\' managed identities and the resources their remediation deploys.')
param location string

@description('Per-environment values for policy parameters, by input name (log_analytics_workspace_id, ...).')
param policyValues object = {}

@description('Management groups, parents before children. A null parentId puts the group under parentManagementGroupId.')
param managementGroups array

@description('Existing management group the hierarchy is created under. Empty for the tenant root group.')
param parentManagementGroupId string = ''

@description('Custom policy definitions, created at the top management group.')
param policyDefinitions array = []

@description('Custom policy set definitions (initiatives), created at the top management group.')
param policySetDefinitions array = []

@description('Policy assignments, each with the managementGroupId it is assigned at.')
param policyAssignments array = []

@description('Policy exemptions: { name, managementGroupId, assignment, scope: { kind, ... }, policyDefinitionReferenceIds, category, expiresOn }.')
param policyExemptions array = []

@description('Tenant hierarchy settings: { defaultManagementGroupId, requireAuthorizationForGroupCreation }. Empty to leave them as they are.')
param hierarchySettings object = {}

@description('PIM: { eligibleDurationDays, eligibilities: [{ name, roleDefinitionId, managementGroupId, input }] }. Role settings are set by scripts/set-pim-policies.sh.')
param pim object = {}

@description('Custom roles defined at the top management group: { name (GUID), roleName, description, permissions }.')
param roleDefinitions array = []

module customRoles 'modules/role-definitions.bicep' = if (!empty(roleDefinitions)) {
  name: take('role-definitions-\${rootId}', 64)
  scope: managementGroup(rootId)
  params: {
    roleDefinitions: roleDefinitions
  }
  dependsOn: [mgs]
}

@description('Platform resources to create for the policies to point at: { logAnalyticsWorkspace, userAssignedIdentity, dataCollectionRules, privateDnsResourceGroup }.')
param platformResources object = {}

@description('Roles remediation identities get on the platform resource groups: { managementGroupId, assignment, roleDefinitionId, scope }.')
param platformRoleAssignments array = []

@description('Log Analytics workspace retention in days.')
param logAnalyticsRetentionInDays int = 30

@description('Subscriptions to move into management groups: { managementGroupId, input }, input naming the policyValues key with the subscription ID.')
param subscriptionPlacements array = []

var rootId = managementGroups[0].id
var defaultParent = empty(parentManagementGroupId) ? tenant().tenantId : parentManagementGroupId

// Platform resources. Their IDs are built from names, so the policies can use them before they exist.
var platform = union(
  { logAnalyticsWorkspace: false, userAssignedIdentity: false, dataCollectionRules: [], privateDnsResourceGroup: false, privateDnsZones: [] },
  platformResources
)
var deployManagement = platform.logAnalyticsWorkspace || platform.userAssignedIdentity
// Conditional modules still need a valid scope.
var unusedSubscription = '00000000-0000-0000-0000-000000000000'
var management = {
  subscriptionId: deployManagement ? policyValues.management_subscription_id : unusedSubscription
  resourceGroupName: policyValues.?management_resource_group_name ?? 'unused'
}
var privateDns = {
  subscriptionId: platform.privateDnsResourceGroup ? policyValues.private_dns_zone_subscription_id : unusedSubscription
  resourceGroupName: policyValues.?private_dns_zone_resource_group_name ?? 'unused'
}
var names = {
  workspace: policyValues.?log_analytics_workspace_name ?? 'unused'
  identity: policyValues.?ama_user_assigned_managed_identity_name ?? 'unused'
  vmInsights: policyValues.?vm_insights_data_collection_rule_name ?? 'unused'
  changeTracking: policyValues.?change_tracking_data_collection_rule_name ?? 'unused'
  defenderSql: policyValues.?defender_sql_data_collection_rule_name ?? 'unused'
}
var managementGroupScope = '/subscriptions/\${management.subscriptionId}/resourceGroups/\${management.resourceGroupName}'
var platformValues = deployManagement
  ? {
      log_analytics_workspace_id: '\${managementGroupScope}/providers/Microsoft.OperationalInsights/workspaces/\${names.workspace}'
      ama_user_assigned_managed_identity_id: '\${managementGroupScope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/\${names.identity}'
      ama_vm_insights_data_collection_rule_id: '\${managementGroupScope}/providers/Microsoft.Insights/dataCollectionRules/\${names.vmInsights}'
      ama_change_tracking_data_collection_rule_id: '\${managementGroupScope}/providers/Microsoft.Insights/dataCollectionRules/\${names.changeTracking}'
      ama_mdfc_sql_data_collection_rule_id: '\${managementGroupScope}/providers/Microsoft.Insights/dataCollectionRules/\${names.defenderSql}'
    }
  : {}
var values = union(policyValues, { location: location }, platformValues)

module managementResourceGroup 'modules/resource-group.bicep' = if (deployManagement) {
  name: take('management-rg-\${rootId}', 64)
  scope: subscription(management.subscriptionId)
  params: {
    name: management.resourceGroupName
    location: location
  }
}

module managementResources 'modules/management-resources.bicep' = if (deployManagement) {
  name: take('management-resources-\${rootId}', 64)
  scope: resourceGroup(management.subscriptionId, management.resourceGroupName)
  params: {
    location: location
    names: names
    logAnalyticsWorkspace: platform.logAnalyticsWorkspace
    userAssignedIdentity: platform.userAssignedIdentity
    dataCollectionRules: platform.dataCollectionRules
    retentionInDays: logAnalyticsRetentionInDays
  }
  dependsOn: [managementResourceGroup]
}

module privateDnsResourceGroup 'modules/resource-group.bicep' = if (platform.privateDnsResourceGroup) {
  name: take('private-dns-rg-\${rootId}', 64)
  scope: subscription(privateDns.subscriptionId)
  params: {
    name: privateDns.resourceGroupName
    location: location
  }
}

module privateDnsZones 'modules/private-dns-zones.bicep' = if (platform.privateDnsResourceGroup && !empty(platform.privateDnsZones)) {
  name: take('private-dns-zones-\${rootId}', 64)
  scope: resourceGroup(privateDns.subscriptionId, privateDns.resourceGroupName)
  params: {
    zones: platform.privateDnsZones
  }
  dependsOn: [privateDnsResourceGroup]
}

// One at a time, in order, so each parent exists before its children.
@batchSize(1)
resource mgs 'Microsoft.Management/managementGroups@2023-04-01' = [
  for mg in managementGroups: {
    name: mg.id
    properties: {
      displayName: mg.displayName
      details: {
        parent: {
          id: tenantResourceId('Microsoft.Management/managementGroups', mg.?parentId ?? defaultParent)
        }
      }
    }
  }
]

// New subscriptions land in the default management group (the parking lot) instead of the tenant root group.
resource tenantRootGroup 'Microsoft.Management/managementGroups@2023-04-01' existing = {
  name: tenant().tenantId
}

resource tenantSettings 'Microsoft.Management/managementGroups/settings@2023-04-01' = if (!empty(hierarchySettings)) {
  parent: tenantRootGroup
  name: 'default'
  properties: {
    defaultManagementGroup: tenantResourceId('Microsoft.Management/managementGroups', hierarchySettings.?defaultManagementGroupId ?? rootId)
    requireAuthorizationForGroupCreation: hierarchySettings.?requireAuthorizationForGroupCreation ?? false
  }
  dependsOn: [mgs]
}

module definitions 'modules/policy-definitions.bicep' = {
  name: take('policy-definitions-\${rootId}', 64)
  scope: managementGroup(rootId)
  params: {
    policyDefinitions: policyDefinitions
    policySetDefinitions: policySetDefinitions
  }
  dependsOn: [mgs]
}

module assignments 'modules/policy-assignments.bicep' = [
  for mg in managementGroups: {
    name: take('policy-assignments-\${mg.id}', 64)
    scope: managementGroup(mg.id)
    params: {
      location: location
      policyValues: values
      policyAssignments: filter(policyAssignments, a => a.managementGroupId == mg.id)
    }
    dependsOn: [definitions, managementResources, privateDnsResourceGroup, privateDnsZones]
  }
]

// Skips grants on resources still at an ALZ placeholder ID.
var managementGroupIds = map(managementGroups, mg => mg.id)
var grants = filter(
  platformRoleAssignments,
  g => g.scope == 'management' || g.scope == 'privateDns' || !contains(values[?g.scope] ?? unusedSubscription, unusedSubscription)
)

module platformRoles 'modules/role-assignment.bicep' = [
  for g in grants: {
    name: take('policy-role-\${uniqueString(g.managementGroupId, g.assignment, g.scope, g.roleDefinitionId)}', 64)
    scope: resourceGroup(
      g.scope == 'management'
        ? management.subscriptionId
        : g.scope == 'privateDns' ? privateDns.subscriptionId : split(values[g.scope], '/')[2],
      g.scope == 'management'
        ? management.resourceGroupName
        : g.scope == 'privateDns' ? privateDns.resourceGroupName : split(values[g.scope], '/')[4]
    )
    params: {
      principalId: assignments[indexOf(managementGroupIds, g.managementGroupId)].outputs.principalIds[indexOf(
        map(filter(policyAssignments, a => a.managementGroupId == g.managementGroupId), a => a.name),
        g.assignment
      )]
      roleDefinitionId: g.roleDefinitionId
      description: 'Remediation for policy assignment \${g.assignment} at \${g.managementGroupId}'
    }
  }
]

// Platform subscriptions in their management groups, so its policy assignments apply to them.
var placements = filter(subscriptionPlacements, p => !empty(values[?p.input] ?? ''))

resource subscriptionPlacement 'Microsoft.Management/managementGroups/subscriptions@2023-04-01' = [
  for p in placements: {
    name: '\${p.managementGroupId}/\${values[p.input]}'
    dependsOn: [mgs]
  }
]

// PIM eligible assignments: groups (object IDs in policyValues) that can activate a privileged role.
module pimEligibility 'modules/pim-eligibility.bicep' = [
  for mg in managementGroups: if (!empty(pim)) {
    name: take('pim-eligibility-\${mg.id}', 64)
    scope: managementGroup(mg.id)
    params: {
      eligibilities: filter(pim.?eligibilities ?? [], e => e.managementGroupId == mg.id && !empty(values[?e.input] ?? ''))
      policyValues: values
      durationDays: pim.?eligibleDurationDays ?? 180
    }
    // Eligibility for a custom role needs the role first.
    dependsOn: [mgs, customRoles]
  }
]

// Exemptions, at their scope. They point at the assignments by ID, after those exist.
var exemptionsAt = {
  managementGroup: filter(policyExemptions, e => e.scope.kind == 'managementGroup')
  subscription: filter(policyExemptions, e => e.scope.kind == 'subscription')
  resourceGroup: filter(policyExemptions, e => e.scope.kind == 'resourceGroup')
}

module managementGroupExemptions 'modules/policy-exemption-mg.bicep' = [
  for e in exemptionsAt.managementGroup: {
    name: take('exemption-\${uniqueString(e.scope.managementGroupId, e.name)}', 64)
    scope: managementGroup(e.scope.managementGroupId)
    params: {
      exemption: e
    }
    dependsOn: [assignments]
  }
]

module subscriptionExemptions 'modules/policy-exemption-subscription.bicep' = [
  for e in exemptionsAt.subscription: {
    name: take('exemption-\${uniqueString(e.scope.subscriptionId, e.name)}', 64)
    scope: subscription(e.scope.subscriptionId)
    params: {
      exemption: e
    }
    dependsOn: [assignments]
  }
]

module resourceGroupExemptions 'modules/policy-exemption-rg.bicep' = [
  for e in exemptionsAt.resourceGroup: {
    name: take('exemption-\${uniqueString(e.scope.subscriptionId, e.scope.resourceGroupName, e.name)}', 64)
    scope: resourceGroup(e.scope.subscriptionId, e.scope.resourceGroupName)
    params: {
      exemption: e
    }
    dependsOn: [assignments]
  }
]

output managementGroupIds array = [for (mg, i) in managementGroups: mgs[i].id]
`;
}

export function toBicepResourceGroupModule(): string {
  return `${commentBlock('//', ['A resource group.', GENERATOR])}
targetScope = 'subscription'

param name string
param location string

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: name
  location: location
}
`;
}

export function toBicepPrivateDnsZonesModule(): string {
  return `${commentBlock('//', [
    'Private link DNS zones. Link them to the hub virtual network(s) so workloads resolve',
    'private endpoints; ALZ\'s Deploy-Private-DNS-Zones policy adds the records.',
    GENERATOR,
  ])}
targetScope = 'resourceGroup'

param zones array

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for name in zones: {
    name: name
    location: 'global'
  }
]
`;
}

/** A policy exemption module for one scope type. */
export function toBicepExemptionModule(scope: 'managementGroup' | 'subscription' | 'resourceGroup'): string {
  return `${commentBlock('//', [`A policy exemption at ${scope === 'managementGroup' ? 'a management group' : scope === 'subscription' ? 'a subscription' : 'a resource group'}.`, GENERATOR])}
targetScope = '${scope}'

@description('{ name, displayName, description, managementGroupId, assignment, policyDefinitionReferenceIds, category, expiresOn }')
param exemption object

resource policyExemption 'Microsoft.Authorization/policyExemptions@2022-07-01-preview' = {
  name: exemption.name
  properties: {
    policyAssignmentId: extensionResourceId(
      tenantResourceId('Microsoft.Management/managementGroups', exemption.managementGroupId),
      'Microsoft.Authorization/policyAssignments',
      exemption.assignment
    )
    policyDefinitionReferenceIds: exemption.policyDefinitionReferenceIds
    exemptionCategory: exemption.category
    displayName: exemption.displayName
    description: exemption.description
    expiresOn: exemption.?expiresOn
  }
}
`;
}

export function toBicepRoleDefinitionsModule(): string {
  return `${commentBlock('//', ['Custom roles, assignable at this management group and everything under it.', GENERATOR])}
targetScope = 'managementGroup'

@description('{ name (GUID), roleName, description, permissions: [{ actions, notActions, dataActions, notDataActions }] }')
param roleDefinitions array

resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = [
  for r in roleDefinitions: {
    name: r.name
    properties: {
      roleName: r.roleName
      description: r.description
      type: 'CustomRole'
      permissions: r.permissions
      assignableScopes: [managementGroup().id]
    }
  }
]
`;
}

export function toBicepPimModule(): string {
  return `${commentBlock('//', ['PIM eligible role assignments at one management group.', GENERATOR])}
targetScope = 'managementGroup'

@description('{ name, roleDefinitionId, managementGroupId, input }: input names the policyValues key with the group object ID.')
param eligibilities array
param policyValues object
@description('How long the eligible assignments last.')
param durationDays int
param startDateTime string = utcNow()

// Re-deploying an unchanged request fails with RoleAssignmentExists; remove it from
// the parameters (or extend it in PIM) once it exists.
resource eligibility 'Microsoft.Authorization/roleEligibilityScheduleRequests@2022-04-01-preview' = [
  for e in eligibilities: {
    name: guid(managementGroup().id, e.input, e.roleDefinitionId)
    properties: {
      principalId: policyValues[e.input]
      roleDefinitionId: extensionResourceId(managementGroup().id, 'Microsoft.Authorization/roleDefinitions', e.roleDefinitionId)
      requestType: 'AdminAssign'
      justification: '\${e.name}: eligible by design (Azure Governance Planner).'
      scheduleInfo: {
        startDateTime: startDateTime
        expiration: {
          type: 'AfterDuration'
          duration: 'P\${durationDays}D'
        }
      }
    }
  }
]
`;
}

/** Bash + az CLI + jq: PIM role settings at every management group (Bicep can only patch existing policies). */
export function toPimPolicyScript(model: IacModel, options: ExportOptions): string {
  const p = model.pim!;
  const approver = model.inputs.find((i) => i.name === 'pim_approver_group_id');
  const approverValue = approver ? inputValue(approver, model, options) : '';
  const calls = p.managementGroupIds.flatMap((mg) =>
    p.roles.map((r) => `apply "/providers/Microsoft.Management/managementGroups/${mg}" "${r.roleDefinitionId}" ${r.requireApproval} # ${r.name}`),
  );
  return `#!/usr/bin/env bash
# PIM role settings for the design's privileged roles at every management group:
# ${p.profile} profile, activations up to ${p.activationMaximumDuration}, MFA${p.requireTicket ? ', a ticket' : ''} and justification required,
# eligibility up to ${p.eligibleExpireAfter} and active assignments up to ${p.activeExpireAfter} (no permanent assignments).
# ${GENERATOR}
#
# Run after the deployment created the management groups:
#   az login
#   bash scripts/set-pim-policies.sh
#
# Needs the az CLI, jq, Entra ID P2 (or Entra ID Governance) and Owner or
# Role Based Access Control Administrator on the management groups. Each policy
# is read, its rules changed in place and written back.
set -euo pipefail

APPROVER_GROUP_ID="\${PIM_APPROVER_GROUP_ID:-${approverValue}}"
API="2020-10-01"
ARM="$(az cloud show --query endpoints.resourceManager -o tsv)"
ARM="\${ARM%/}"

apply() {
  local scope="$1" role="$2" approval="$3"
  local policy id body
  policy="$(az rest --method get \\
    --url "\${ARM}\${scope}/providers/Microsoft.Authorization/roleManagementPolicies?api-version=\${API}" \\
    --uri-parameters "\\\$filter=roleDefinitionId eq '\${scope}/providers/Microsoft.Authorization/roleDefinitions/\${role}'" \\
    --query "value[0]" -o json)"
  id="$(jq -r .id <<<"$policy")"
  body="$(jq \\
    --arg act "${p.activationMaximumDuration}" --arg elig "${p.eligibleExpireAfter}" --arg active "${p.activeExpireAfter}" \\
    --argjson mfa ${p.requireMfa} --argjson just ${p.requireJustification} --argjson ticket ${p.requireTicket} \\
    --argjson approval "$approval" --arg approver "$APPROVER_GROUP_ID" '
    def checks: [(if $mfa then "MultiFactorAuthentication" else empty end), (if $just then "Justification" else empty end)];
    def approve: $approval and ($approver != "");
    { properties: { rules: [ .properties.rules[] |
      if .id == "Expiration_EndUser_Assignment" then .maximumDuration = $act
      elif .id == "Enablement_EndUser_Assignment" then .enabledRules = (checks + (if $ticket then ["Ticketing"] else [] end))
      elif .id == "Approval_EndUser_Assignment" then
        .setting.isApprovalRequired = approve
        | if approve then .setting.approvalStages = [{ approvalStageTimeOutInDays: 1, isApproverJustificationRequired: true,
            escalationTimeInMinutes: 0, isEscalationEnabled: false,
            primaryApprovers: [{ id: $approver, userType: "Group", isBackup: false }] }] else . end
      elif .id == "Expiration_Admin_Eligibility" then .isExpirationRequired = true | .maximumDuration = $elig
      elif .id == "Expiration_Admin_Assignment" then .isExpirationRequired = true | .maximumDuration = $active
      elif .id == "Enablement_Admin_Assignment" then .enabledRules = checks
      elif (.id | startswith("Notification_Admin_")) then .isDefaultRecipientsEnabled = true | .notificationLevel = "All"
      else . end ] } }' <<<"$policy")"
  az rest --method patch --url "\${ARM}\${id}?api-version=\${API}" --body "$body" -o none
  echo "Set PIM settings for role \${role} at \${scope}"
}

${calls.join('\n')}
`;
}

export function toBicepRoleAssignmentModule(): string {
  return `${commentBlock('//', ["A role for a policy assignment's managed identity on a resource group.", GENERATOR])}
targetScope = 'resourceGroup'

param principalId string
param roleDefinitionId string
param description string = ''

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, roleDefinitionId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: description
  }
}
`;
}

/** Workspace solutions each data collection rule's data needs. */
const SOLUTIONS: Record<DataCollectionRule, string[]> = {
  vmInsights: ['VMInsights'],
  changeTracking: ['ChangeTracking'],
  defenderSql: ['SQLAdvancedThreatProtection', 'SQLVulnerabilityAssessment'],
};

const CHANGE_TRACKING_STREAMS = ['Microsoft-ConfigurationChange', 'Microsoft-ConfigurationChangeV2', 'Microsoft-ConfigurationData'];
const DEFENDER_SQL_STREAMS = [
  'Microsoft-DefenderForSqlAlerts',
  'Microsoft-DefenderForSqlLogins',
  'Microsoft-DefenderForSqlTelemetry',
  'Microsoft-DefenderForSqlScanEvents',
  'Microsoft-DefenderForSqlScanResults',
];

/** Change Tracking and Inventory settings, as ALZ's data collection rule sets them. */
const changeTrackingSettings = (os: 'Windows' | 'Linux') => ({
  enableFiles: true,
  enableSoftware: true,
  enableRegistry: os === 'Windows',
  enableServices: true,
  enableInventory: true,
  ...(os === 'Windows'
    ? {
        registrySettings: {
          registryCollectionFrequency: 3000,
          registryInfo: [
            {
              name: 'Registry_1',
              groupTag: 'Recommended',
              enabled: false,
              recurse: true,
              description: '',
              keyName: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Group Policy\\Scripts\\Startup',
              valueName: '',
            },
          ],
        },
      }
    : {}),
  fileSettings: {
    fileCollectionFrequency: 900,
    fileInfo:
      os === 'Linux'
        ? [
            {
              name: 'ChangeTrackingLinuxPath_default',
              enabled: true,
              destinationPath: '/etc/.*.conf',
              useSudo: true,
              recurse: true,
              maxContentsReturnable: 5000000,
              pathType: 'File',
              type: 'File',
              links: 'Follow',
              maxOutputSize: 500000,
              groupTag: 'Recommended',
            },
          ]
        : [],
  },
  softwareSettings: { softwareCollectionFrequency: 300 },
  inventorySettings: { inventoryCollectionFrequency: 36000 },
  servicesSettings: { serviceCollectionFrequency: 300 },
});

/** A JSON value as a Bicep literal. */
function bicepValue(value: unknown, indent = ''): string {
  const next = indent + '  ';
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => next + bicepValue(v, next)).join('\n')}\n${indent}]` : '[]';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length
      ? `{\n${entries.map(([k, v]) => `${next}${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : bicepString(k)}: ${bicepValue(v, next)}`).join('\n')}\n${indent}}`
      : '{}';
  }
  return typeof value === 'string' ? bicepString(value) : String(value);
}

export function toBicepManagementModule(): string {
  const solutions = Object.entries(SOLUTIONS)
    .map(([rule, list]) => `  ${rule}: [${list.map(bicepString).join(', ')}]`)
    .join('\n');
  return `${commentBlock('//', [
    "Management resources ALZ's policies point at: the Log Analytics workspace, the",
    'Azure Monitor Agent identity and the data collection rules.',
    GENERATOR,
  ])}
targetScope = 'resourceGroup'

param location string
@description('workspace, identity, vmInsights, changeTracking and defenderSql names.')
param names object
param logAnalyticsWorkspace bool
param userAssignedIdentity bool
@description('Any of vmInsights, changeTracking, defenderSql.')
param dataCollectionRules array
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (logAnalyticsWorkspace) {
  name: names.workspace
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
  }
}

// Workspace solutions the rules' data needs.
var solutionsByRule = {
${solutions}
}
var solutions = flatten(map(dataCollectionRules, rule => solutionsByRule[rule]))

resource solution 'Microsoft.OperationsManagement/solutions@2015-11-01-preview' = [
  for s in solutions: if (logAnalyticsWorkspace) {
    name: '\${s}(\${names.workspace})'
    location: location
    plan: {
      name: '\${s}(\${names.workspace})'
      publisher: 'Microsoft'
      product: 'OMSGallery/\${s}'
      promotionCode: ''
    }
    properties: {
      workspaceResourceId: workspace.id
    }
  }
]

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (userAssignedIdentity) {
  name: names.identity
  location: location
}

resource vmInsights 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (contains(dataCollectionRules, 'vmInsights')) {
  name: names.vmInsights
  location: location
  properties: {
    description: 'VM Insights performance counters and dependency map, for ALZ\\'s Deploy-VM-Monitoring policies.'
    dataSources: {
      performanceCounters: [
        {
          name: 'VMInsightsPerfCounters'
          streams: ['Microsoft-InsightsMetrics']
          samplingFrequencyInSeconds: 60
          counterSpecifiers: ['\\\\VmInsights\\\\DetailedMetrics']
        }
      ]
      extensions: [
        {
          name: 'DependencyAgentDataSource'
          streams: ['Microsoft-ServiceMap']
          extensionName: 'DependencyAgent'
          extensionSettings: {}
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'VMInsightsPerf-Logs-Dest'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: ['Microsoft-InsightsMetrics']
        destinations: ['VMInsightsPerf-Logs-Dest']
      }
      {
        streams: ['Microsoft-ServiceMap']
        destinations: ['VMInsightsPerf-Logs-Dest']
      }
    ]
  }
}

resource changeTracking 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (contains(dataCollectionRules, 'changeTracking')) {
  name: names.changeTracking
  location: location
  properties: {
    description: 'Change Tracking and Inventory, for ALZ\\'s Deploy-*-ChangeTrack policies.'
    dataSources: {
      extensions: [
        {
          name: 'CTDataSource-Windows'
          streams: ${bicepValue(CHANGE_TRACKING_STREAMS, '          ')}
          extensionName: 'ChangeTracking-Windows'
          extensionSettings: ${bicepValue(changeTrackingSettings('Windows'), '          ')}
        }
        {
          name: 'CTDataSource-Linux'
          streams: ${bicepValue(CHANGE_TRACKING_STREAMS, '          ')}
          extensionName: 'ChangeTracking-Linux'
          extensionSettings: ${bicepValue(changeTrackingSettings('Linux'), '          ')}
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'Microsoft-CT-Dest'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: ${bicepValue(CHANGE_TRACKING_STREAMS, '        ')}
        destinations: ['Microsoft-CT-Dest']
      }
    ]
  }
  dependsOn: [solution]
}

resource defenderSql 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (contains(dataCollectionRules, 'defenderSql')) {
  name: names.defenderSql
  location: location
  properties: {
    description: 'Microsoft Defender for SQL on machines, for ALZ\\'s Deploy-MDFC-DefSQL-AMA policy.'
    dataSources: {
      extensions: [
        {
          name: 'MicrosoftDefenderForSQL'
          streams: ${bicepValue(DEFENDER_SQL_STREAMS, '          ')}
          extensionName: 'MicrosoftDefenderForSQL'
          extensionSettings: {
            enableCollectionOfSqlQueriesForSecurityResearch: false
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'LogAnalyticsDest'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: ${bicepValue(DEFENDER_SQL_STREAMS, '        ')}
        destinations: ['LogAnalyticsDest']
      }
    ]
  }
  dependsOn: [solution]
}
`;
}

export function toBicepDefinitionsModule(): string {
  return `${commentBlock('//', ['Custom policy definitions and initiatives at one management group.', GENERATOR])}
targetScope = 'managementGroup'

param policyDefinitions array
param policySetDefinitions array

resource defs 'Microsoft.Authorization/policyDefinitions@2025-01-01' = [
  for def in policyDefinitions: {
    name: def.name
    properties: def.properties
  }
]

resource sets 'Microsoft.Authorization/policySetDefinitions@2025-01-01' = [
  for set in policySetDefinitions: {
    name: set.name
    properties: set.properties
    dependsOn: [defs]
  }
]
`;
}

export function toBicepAssignmentsModule(): string {
  return `${commentBlock('//', [
    'Policy assignments at one management group, and the role assignments their',
    'managed identities need for remediation.',
    GENERATOR,
  ])}
targetScope = 'managementGroup'

param location string
param policyValues object
param policyAssignments array

resource assignments 'Microsoft.Authorization/policyAssignments@2025-01-01' = [
  for a in policyAssignments: {
    name: a.name
    location: location
    identity: {
      type: a.identity ? 'SystemAssigned' : 'None'
    }
    properties: {
      displayName: a.displayName
      description: a.description
      policyDefinitionId: a.policyDefinitionId
      definitionVersion: a.?definitionVersion
      enforcementMode: a.enforcementMode
      // Fixed values, plus the parameters that take a per-environment value.
      parameters: union(a.parameters, toObject(items(a.inputs), p => p.key, p => { value: policyValues[p.value] }))
      nonComplianceMessages: a.nonComplianceMessages
      notScopes: a.?notScopes ?? []
      // Effect overrides, e.g. Disabled for manual-attestation policies.
      overrides: a.?overrides ?? []
    }
  }
]

var roles = flatten(map(range(0, length(policyAssignments)), i => map(policyAssignments[i].roleDefinitionIds, role => {
  index: i
  role: role
})))

resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for r in roles: {
    name: guid(managementGroup().id, policyAssignments[r.index].name, r.role)
    properties: {
      roleDefinitionId: tenantResourceId('Microsoft.Authorization/roleDefinitions', r.role)
      principalId: assignments[r.index].identity.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

@description('Principal IDs of the assignment identities, in policyAssignments order (empty without one).')
output principalIds array = [for (a, i) in policyAssignments: assignments[i].?identity.?principalId ?? '']
`;
}

export function toBicepParams(model: IacModel, options: ExportOptions): string {
  const env = environmentOf(options);
  const location = model.inputs.find((i) => i.name === 'location');
  const values = model.inputs.filter((i) => i.name !== 'location');
  const unset = new Set(unsetInputs(model, options).map((i) => i.name));
  const lines = [
    ...values.flatMap((i) => [
      `  // ${i.description}${unset.has(i.name) ? ' SET THIS: still the ALZ placeholder.' : ''}`,
      `  ${i.name}: ${bicepString(inputValue(i, model, options))}`,
    ]),
    ...aliasLines(model, options).map(([name, value, of]) => `  ${name}: ${bicepString(value)} // same as ${of}`),
  ];
  return `${commentBlock('//', [
    `${model.rootName}, ${env} environment. ${GENERATOR}`,
    '',
    ...summaryLines(model),
    '',
    'Deploy:',
    `  az deployment tenant create --name governance-${env} --location ${location ? inputValue(location, model, options) : 'eastus2'} --parameters ${env}.bicepparam`,
  ])}
using 'main.bicep'

param location = ${bicepString(location ? inputValue(location, model, options) : 'eastus2')}

param policyValues = {
${lines.join('\n')}
}

// The design, as data.
param managementGroups = loadJsonContent('lib/management-groups.json')
param policyDefinitions = loadJsonContent('lib/policy-definitions.json')
param policySetDefinitions = loadJsonContent('lib/policy-set-definitions.json')
param policyAssignments = loadJsonContent('lib/policy-assignments.json')
param platformResources = loadJsonContent('lib/platform-resources.json')
param policyExemptions = loadJsonContent('lib/policy-exemptions.json')
param hierarchySettings = loadJsonContent('lib/hierarchy-settings.json')
param pim = loadJsonContent('lib/pim.json')
param roleDefinitions = loadJsonContent('lib/role-definitions.json')
param platformRoleAssignments = loadJsonContent('lib/platform-role-assignments.json')
param subscriptionPlacements = loadJsonContent('lib/subscription-placements.json')
`;
}

// --- Terraform -----------------------------------------------------------------

// HCL escapes interpolation as $${ and %%{. (A replacer function avoids JS's own `$$` handling.)
const tq = (s: string) =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/([$%])\{/g, (_, sigil: string) => `${sigil}${sigil}{`)}"`;

/** The Terraform module. As a Terragrunt module it leaves out the provider, which root.hcl generates. */
export function toTerraform(options: { terragrunt?: boolean } = {}): string {
  const header = options.terragrunt
    ? [
        'Terragrunt module: the provider and backend are generated by root.hcl, and every',
        'input comes from live/<env>/governance (terragrunt.hcl and design.json).',
      ]
    : [
        'Every input is a variable: the design is in design.auto.tfvars.json (loaded',
        'automatically) and the per-environment values in <env>.tfvars.',
        '  terraform init',
        '  terraform apply -var-file=<env>.tfvars',
      ];
  const provider = options.terragrunt
    ? ''
    : `
# The subscription comes from ARM_SUBSCRIPTION_ID (or az account show).
provider "azurerm" {
  environment = var.cloud_environment
  features {}
}
`;
  return `${commentBlock('#', ['Management groups, custom policy definitions and policy assignments from data.', GENERATOR, '', ...header])}
terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    # The tenant's hierarchy settings have no azurerm resource.
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

provider "azapi" {
  environment = var.cloud_environment
}
${provider}
# Platform resources go in the management and private DNS zone subscriptions
# (policy_values management_subscription_id / private_dns_zone_subscription_id).
provider "azurerm" {
  alias           = "management"
  environment     = var.cloud_environment
  subscription_id = lookup(var.policy_values, "management_subscription_id", "") != "" ? var.policy_values["management_subscription_id"] : null
  features {}
}

provider "azurerm" {
  alias           = "connectivity"
  environment     = var.cloud_environment
  subscription_id = lookup(var.policy_values, "private_dns_zone_subscription_id", "") != "" ? var.policy_values["private_dns_zone_subscription_id"] : null
  features {}
}

variable "cloud_environment" {
  description = "Azure cloud: public or usgovernment."
  type        = string
  default     = "public"
}

variable "location" {
  description = "Region of the policy assignments' managed identities and the resources their remediation deploys."
  type        = string
}

variable "policy_values" {
  description = "Per-environment values for policy parameters, by input name (log_analytics_workspace_id, ...)."
  type        = map(string)
  default     = {}
}

variable "parent_management_group_id" {
  description = "Resource ID of an existing management group to create the hierarchy under. Null for the tenant root group."
  type        = string
  default     = null
}

variable "management_groups" {
  description = "Management groups. A null parent_id puts the group under parent_management_group_id. Up to four levels."
  type = list(object({
    id           = string
    display_name = string
    parent_id    = optional(string)
  }))
}

variable "policy_definitions" {
  description = "Custom policy definitions, created at the top management group. JSON-encoded fields."
  type = list(object({
    name         = string
    display_name = string
    description  = optional(string)
    mode         = string
    metadata     = optional(string)
    parameters   = optional(string)
    policy_rule  = string
  }))
  default = []
}

variable "policy_set_definitions" {
  description = "Custom initiatives, created at the top management group. JSON-encoded fields."
  type = list(object({
    name         = string
    display_name = string
    description  = optional(string)
    metadata     = optional(string)
    parameters   = optional(string)
    policy_definitions = list(object({
      policy_definition_id = string
      reference_id         = optional(string)
      parameter_values     = optional(string)
      policy_group_names   = optional(list(string), [])
    }))
    policy_definition_groups = optional(list(object({
      name         = string
      display_name = optional(string)
      category     = optional(string)
      description  = optional(string)
    })), [])
  }))
  default = []
}

variable "policy_assignments" {
  description = "Policy assignments. parameters is JSON; inputs maps a parameter to a policy_values key (or location)."
  type = list(object({
    management_group_id  = string
    name                 = string
    display_name         = string
    description          = optional(string)
    policy_definition_id = string
    enforce              = bool
    identity             = bool
    parameters           = optional(string, "{}")
    inputs               = optional(map(string), {})
    non_compliance_messages = optional(list(object({
      content                        = string
      policy_definition_reference_id = optional(string)
    })), [])
    role_definition_ids = optional(list(string), [])
    not_scopes          = optional(list(string), [])
    overrides = optional(list(object({
      value         = string
      reference_ids = list(string)
    })), [])
  }))
  default = []
}

variable "policy_exemptions" {
  description = "Policy exemptions. scope_kind: managementGroup, subscription or resourceGroup."
  type = list(object({
    name                            = string
    display_name                    = string
    description                     = optional(string)
    management_group_id             = string
    assignment                      = string
    scope_kind                      = string
    scope_management_group_id       = optional(string)
    scope_subscription_id           = optional(string)
    scope_resource_group_name       = optional(string)
    policy_definition_reference_ids = optional(list(string), [])
    category                        = string
    expires_on                      = optional(string)
  }))
  default = []
}

variable "platform_resources" {
  description = "Platform resources to create for the policies to point at. data_collection_rules: any of vmInsights, changeTracking, defenderSql."
  type = object({
    log_analytics_workspace    = optional(bool, false)
    user_assigned_identity     = optional(bool, false)
    data_collection_rules      = optional(list(string), [])
    private_dns_resource_group = optional(bool, false)
    private_dns_zones          = optional(list(string), [])
  })
  default = {}
}

variable "platform_role_assignments" {
  description = "Roles remediation identities get on platform resource groups. scope: management, privateDns or a policy_values key holding a resource ID."
  type = list(object({
    management_group_id = string
    assignment          = string
    role_definition_id  = string
    scope               = string
  }))
  default = []
}

variable "subscription_placements" {
  description = "Subscriptions to move into management groups. input names the policy_values key holding the subscription ID."
  type = list(object({
    management_group_id = string
    input               = string
  }))
  default = []
}

variable "hierarchy_settings" {
  description = "Tenant hierarchy settings: the management group new subscriptions land in, and whether creating management groups needs permission. Null leaves them as they are."
  type = object({
    default_management_group_id              = string
    require_authorization_for_group_creation = bool
  })
  default = null
}

variable "pim" {
  description = "Privileged Identity Management: role settings at every management group and eligible assignments (group object IDs in policy_values). Null to leave PIM as it is."
  type = object({
    activation_maximum_duration = string
    require_mfa                 = bool
    require_justification       = bool
    require_ticket              = bool
    eligible_expire_after       = string
    active_expire_after         = string
    eligible_duration_days      = number
    roles = list(object({
      name               = string
      role_definition_id = string
      require_approval   = bool
    }))
    eligibilities = list(object({
      name                = string
      role_definition_id  = string
      management_group_id = string
      input               = string
    }))
  })
  default = null
}

variable "role_definitions" {
  description = "Custom roles defined at the top management group and assignable under it. name is the role definition GUID."
  type = list(object({
    name        = string
    role_name   = string
    description = string
    permissions = list(object({
      actions          = list(string)
      not_actions      = list(string)
      data_actions     = list(string)
      not_data_actions = list(string)
    }))
  }))
  default = []
}

variable "log_analytics_retention_in_days" {
  description = "Log Analytics workspace retention in days."
  type        = number
  default     = 30
}

locals {
  management_groups = { for m in var.management_groups : m.id => m }
  level_1           = { for k, m in local.management_groups : k => m if m.parent_id == null }
  level_2           = { for k, m in local.management_groups : k => m if contains(keys(local.level_1), coalesce(m.parent_id, "-")) }
  level_3           = { for k, m in local.management_groups : k => m if contains(keys(local.level_2), coalesce(m.parent_id, "-")) }
  level_4           = { for k, m in local.management_groups : k => m if contains(keys(local.level_3), coalesce(m.parent_id, "-")) }
  root_id           = var.management_groups[0].id
}

# Management groups by level, so each parent exists before its children.
resource "azurerm_management_group" "level_1" {
  for_each                   = local.level_1
  name                       = each.key
  display_name               = each.value.display_name
  parent_management_group_id = var.parent_management_group_id
}

resource "azurerm_management_group" "level_2" {
  for_each                   = local.level_2
  name                       = each.key
  display_name               = each.value.display_name
  parent_management_group_id = azurerm_management_group.level_1[each.value.parent_id].id
}

resource "azurerm_management_group" "level_3" {
  for_each                   = local.level_3
  name                       = each.key
  display_name               = each.value.display_name
  parent_management_group_id = azurerm_management_group.level_2[each.value.parent_id].id
}

resource "azurerm_management_group" "level_4" {
  for_each                   = local.level_4
  name                       = each.key
  display_name               = each.value.display_name
  parent_management_group_id = azurerm_management_group.level_3[each.value.parent_id].id
}

locals {
  management_group_ids = merge([
    for level in [azurerm_management_group.level_1, azurerm_management_group.level_2, azurerm_management_group.level_3, azurerm_management_group.level_4] :
    { for k, mg in level : k => mg.id }
  ]...)
}

resource "azurerm_policy_definition" "this" {
  for_each            = { for d in var.policy_definitions : d.name => d }
  name                = each.key
  policy_type         = "Custom"
  mode                = each.value.mode
  display_name        = each.value.display_name
  description         = each.value.description
  management_group_id = local.management_group_ids[local.root_id]
  metadata            = each.value.metadata
  parameters          = each.value.parameters
  policy_rule         = each.value.policy_rule
}

resource "azurerm_management_group_policy_set_definition" "this" {
  for_each            = { for s in var.policy_set_definitions : s.name => s }
  name                = each.key
  policy_type         = "Custom"
  display_name        = each.value.display_name
  description         = each.value.description
  management_group_id = local.management_group_ids[local.root_id]
  metadata            = each.value.metadata
  parameters          = each.value.parameters

  dynamic "policy_definition_reference" {
    for_each = each.value.policy_definitions
    content {
      policy_definition_id = policy_definition_reference.value.policy_definition_id
      reference_id         = policy_definition_reference.value.reference_id
      parameter_values     = policy_definition_reference.value.parameter_values
      policy_group_names   = policy_definition_reference.value.policy_group_names
    }
  }

  dynamic "policy_definition_group" {
    for_each = each.value.policy_definition_groups
    content {
      name         = policy_definition_group.value.name
      display_name = policy_definition_group.value.display_name
      category     = policy_definition_group.value.category
      description  = policy_definition_group.value.description
    }
  }

  depends_on = [azurerm_policy_definition.this]
}

# --- Platform resources --------------------------------------------------------

locals {
  platform          = var.platform_resources
  deploy_management = local.platform.log_analytics_workspace || local.platform.user_assigned_identity
  names = {
    workspace       = lookup(var.policy_values, "log_analytics_workspace_name", null)
    identity        = lookup(var.policy_values, "ama_user_assigned_managed_identity_name", null)
    vm_insights     = lookup(var.policy_values, "vm_insights_data_collection_rule_name", null)
    change_tracking = lookup(var.policy_values, "change_tracking_data_collection_rule_name", null)
    defender_sql    = lookup(var.policy_values, "defender_sql_data_collection_rule_name", null)
  }
  # Workspace solutions each data collection rule's data needs.
  solutions_by_rule = {
    vmInsights     = ["VMInsights"]
    changeTracking = ["ChangeTracking"]
    defenderSql    = ["SQLAdvancedThreatProtection", "SQLVulnerabilityAssessment"]
  }
  solutions               = local.platform.log_analytics_workspace ? toset(flatten([for r in local.platform.data_collection_rules : local.solutions_by_rule[r]])) : toset([])
  change_tracking_streams = ["Microsoft-ConfigurationChange", "Microsoft-ConfigurationChangeV2", "Microsoft-ConfigurationData"]
  defender_sql_streams = [
    "Microsoft-DefenderForSqlAlerts",
    "Microsoft-DefenderForSqlLogins",
    "Microsoft-DefenderForSqlTelemetry",
    "Microsoft-DefenderForSqlScanEvents",
    "Microsoft-DefenderForSqlScanResults",
  ]
}

resource "azurerm_resource_group" "management" {
  count    = local.deploy_management ? 1 : 0
  provider = azurerm.management
  name     = var.policy_values["management_resource_group_name"]
  location = var.location
}

resource "azurerm_log_analytics_workspace" "this" {
  count               = local.platform.log_analytics_workspace ? 1 : 0
  provider            = azurerm.management
  name                = local.names.workspace
  location            = var.location
  resource_group_name = azurerm_resource_group.management[0].name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_analytics_retention_in_days
}

resource "azurerm_log_analytics_solution" "this" {
  for_each              = local.solutions
  provider              = azurerm.management
  solution_name         = each.key
  location              = var.location
  resource_group_name   = azurerm_resource_group.management[0].name
  workspace_resource_id = azurerm_log_analytics_workspace.this[0].id
  workspace_name        = azurerm_log_analytics_workspace.this[0].name

  plan {
    publisher = "Microsoft"
    product   = "OMSGallery/\${each.key}"
  }
}

# The identity Azure Monitor Agent authenticates with. It needs no roles: the
# data collection rule associations decide where its data goes.
resource "azurerm_user_assigned_identity" "ama" {
  count               = local.platform.user_assigned_identity ? 1 : 0
  provider            = azurerm.management
  name                = local.names.identity
  location            = var.location
  resource_group_name = azurerm_resource_group.management[0].name
}

resource "azurerm_monitor_data_collection_rule" "vm_insights" {
  count               = contains(local.platform.data_collection_rules, "vmInsights") ? 1 : 0
  provider            = azurerm.management
  name                = local.names.vm_insights
  location            = var.location
  resource_group_name = azurerm_resource_group.management[0].name
  description         = "VM Insights performance counters and dependency map, for ALZ's Deploy-VM-Monitoring policies."

  data_sources {
    performance_counter {
      name                          = "VMInsightsPerfCounters"
      streams                       = ["Microsoft-InsightsMetrics"]
      sampling_frequency_in_seconds = 60
      counter_specifiers            = ["\\\\VmInsights\\\\DetailedMetrics"]
    }
    extension {
      name           = "DependencyAgentDataSource"
      streams        = ["Microsoft-ServiceMap"]
      extension_name = "DependencyAgent"
      extension_json = jsonencode({})
    }
  }

  destinations {
    log_analytics {
      name                  = "VMInsightsPerf-Logs-Dest"
      workspace_resource_id = azurerm_log_analytics_workspace.this[0].id
    }
  }

  data_flow {
    streams      = ["Microsoft-InsightsMetrics"]
    destinations = ["VMInsightsPerf-Logs-Dest"]
  }

  data_flow {
    streams      = ["Microsoft-ServiceMap"]
    destinations = ["VMInsightsPerf-Logs-Dest"]
  }
}

resource "azurerm_monitor_data_collection_rule" "change_tracking" {
  count               = contains(local.platform.data_collection_rules, "changeTracking") ? 1 : 0
  provider            = azurerm.management
  name                = local.names.change_tracking
  location            = var.location
  resource_group_name = azurerm_resource_group.management[0].name
  description         = "Change Tracking and Inventory, for ALZ's Deploy-*-ChangeTrack policies."

  data_sources {
    extension {
      name           = "CTDataSource-Windows"
      streams        = local.change_tracking_streams
      extension_name = "ChangeTracking-Windows"
      extension_json = jsonencode(${hclJson(changeTrackingSettings('Windows'), '      ')})
    }
    extension {
      name           = "CTDataSource-Linux"
      streams        = local.change_tracking_streams
      extension_name = "ChangeTracking-Linux"
      extension_json = jsonencode(${hclJson(changeTrackingSettings('Linux'), '      ')})
    }
  }

  destinations {
    log_analytics {
      name                  = "Microsoft-CT-Dest"
      workspace_resource_id = azurerm_log_analytics_workspace.this[0].id
    }
  }

  data_flow {
    streams      = local.change_tracking_streams
    destinations = ["Microsoft-CT-Dest"]
  }

  depends_on = [azurerm_log_analytics_solution.this]
}

resource "azurerm_monitor_data_collection_rule" "defender_sql" {
  count               = contains(local.platform.data_collection_rules, "defenderSql") ? 1 : 0
  provider            = azurerm.management
  name                = local.names.defender_sql
  location            = var.location
  resource_group_name = azurerm_resource_group.management[0].name
  description         = "Microsoft Defender for SQL on machines, for ALZ's Deploy-MDFC-DefSQL-AMA policy."

  data_sources {
    extension {
      name           = "MicrosoftDefenderForSQL"
      streams        = local.defender_sql_streams
      extension_name = "MicrosoftDefenderForSQL"
      extension_json = jsonencode({ enableCollectionOfSqlQueriesForSecurityResearch = false })
    }
  }

  destinations {
    log_analytics {
      name                  = "LogAnalyticsDest"
      workspace_resource_id = azurerm_log_analytics_workspace.this[0].id
    }
  }

  data_flow {
    streams      = local.defender_sql_streams
    destinations = ["LogAnalyticsDest"]
  }

  depends_on = [azurerm_log_analytics_solution.this]
}

resource "azurerm_resource_group" "private_dns" {
  count    = local.platform.private_dns_resource_group ? 1 : 0
  provider = azurerm.connectivity
  name     = var.policy_values["private_dns_zone_resource_group_name"]
  location = var.location
}

# Private link DNS zones. Link them to the hub virtual network(s) so workloads
# resolve private endpoints; ALZ's Deploy-Private-DNS-Zones policy adds the records.
resource "azurerm_private_dns_zone" "this" {
  for_each            = local.platform.private_dns_resource_group ? toset(local.platform.private_dns_zones) : toset([])
  provider            = azurerm.connectivity
  name                = each.key
  resource_group_name = azurerm_resource_group.private_dns[0].name
}

locals {
  # The created resources' IDs, for the policy parameters that point at them.
  platform_values = {
    for k, v in {
      log_analytics_workspace_id                  = one(azurerm_log_analytics_workspace.this[*].id)
      ama_user_assigned_managed_identity_id       = one(azurerm_user_assigned_identity.ama[*].id)
      ama_vm_insights_data_collection_rule_id     = one(azurerm_monitor_data_collection_rule.vm_insights[*].id)
      ama_change_tracking_data_collection_rule_id = one(azurerm_monitor_data_collection_rule.change_tracking[*].id)
      ama_mdfc_sql_data_collection_rule_id        = one(azurerm_monitor_data_collection_rule.defender_sql[*].id)
    } : k => v if v != null
  }
  policy_values = merge(var.policy_values, { location = var.location }, local.platform_values)
  assignments   = { for a in var.policy_assignments : "\${a.management_group_id}/\${a.name}" => a }
}

resource "azurerm_management_group_policy_assignment" "this" {
  for_each             = local.assignments
  name                 = each.value.name
  management_group_id  = local.management_group_ids[each.value.management_group_id]
  policy_definition_id = each.value.policy_definition_id
  display_name         = each.value.display_name
  description          = each.value.description
  enforce              = each.value.enforce
  not_scopes           = each.value.not_scopes
  location             = var.location
  # Fixed values, plus the parameters that take a per-environment value.
  parameters = jsonencode(merge(
    jsondecode(each.value.parameters),
    { for p, input in each.value.inputs : p => { value = local.policy_values[input] } },
  ))

  dynamic "identity" {
    for_each = each.value.identity ? [1] : []
    content {
      type = "SystemAssigned"
    }
  }

  # Effect overrides by policy reference ID, e.g. Disabled for manual-attestation policies.
  dynamic "overrides" {
    for_each = each.value.overrides
    content {
      value = overrides.value.value
      selectors {
        kind = "policyDefinitionReferenceId"
        in   = overrides.value.reference_ids
      }
    }
  }

  dynamic "non_compliance_message" {
    for_each = each.value.non_compliance_messages
    content {
      content                        = non_compliance_message.value.content
      policy_definition_reference_id = non_compliance_message.value.policy_definition_reference_id
    }
  }

  depends_on = [azurerm_policy_definition.this, azurerm_management_group_policy_set_definition.this, azurerm_private_dns_zone.this]
}

# Roles the assignments' managed identities need for remediation.
resource "azurerm_role_assignment" "policy" {
  for_each = merge([
    for key, a in local.assignments : {
      for role in a.role_definition_ids : "\${key}/\${role}" => { assignment = key, role = role }
    }
  ]...)
  scope              = local.management_group_ids[local.assignments[each.value.assignment].management_group_id]
  role_definition_id = "/providers/Microsoft.Authorization/roleDefinitions/\${each.value.role}"
  principal_id       = azurerm_management_group_policy_assignment.this[each.value.assignment].identity[0].principal_id
  principal_type     = "ServicePrincipal"
}

# Roles the identities need on the platform resource groups their parameters point at.
locals {
  platform_scopes = {
    management = one(azurerm_resource_group.management[*].id)
    privateDns = one(azurerm_resource_group.private_dns[*].id)
  }
  # Skips resources still at an ALZ placeholder ID.
  platform_role_assignments = {
    for g in var.platform_role_assignments : "\${g.management_group_id}/\${g.assignment}/\${g.scope}/\${g.role_definition_id}" => g
    if contains(["management", "privateDns"], g.scope) || !strcontains(lookup(var.policy_values, g.scope, "00000000-0000-0000-0000-000000000000"), "00000000-0000-0000-0000-000000000000")
  }
}

resource "azurerm_role_assignment" "platform" {
  for_each           = local.platform_role_assignments
  scope              = try(local.platform_scopes[each.value.scope], regex("^/subscriptions/[^/]+/resource[Gg]roups/[^/]+", var.policy_values[each.value.scope]))
  role_definition_id = "/providers/Microsoft.Authorization/roleDefinitions/\${each.value.role_definition_id}"
  principal_id       = azurerm_management_group_policy_assignment.this["\${each.value.management_group_id}/\${each.value.assignment}"].identity[0].principal_id
  principal_type     = "ServicePrincipal"
}

# Platform subscriptions in their management groups, so its policy assignments apply to them.
resource "azurerm_management_group_subscription_association" "platform" {
  for_each = {
    for p in var.subscription_placements : "\${p.management_group_id}/\${p.input}" => p
    if lookup(var.policy_values, p.input, "") != ""
  }
  management_group_id = local.management_group_ids[each.value.management_group_id]
  subscription_id     = "/subscriptions/\${var.policy_values[each.value.input]}"
}

# New subscriptions land in the default management group (the parking lot)
# instead of the tenant root group.
data "azapi_client_config" "current" {}

resource "azapi_resource" "hierarchy_settings" {
  count     = var.hierarchy_settings == null ? 0 : 1
  type      = "Microsoft.Management/managementGroups/settings@2023-04-01"
  parent_id = "/providers/Microsoft.Management/managementGroups/\${data.azapi_client_config.current.tenant_id}"
  name      = "default"
  body = {
    properties = {
      defaultManagementGroup               = local.management_group_ids[var.hierarchy_settings.default_management_group_id]
      requireAuthorizationForGroupCreation = var.hierarchy_settings.require_authorization_for_group_creation
    }
  }
}

# --- Custom roles ----------------------------------------------------------------

resource "azurerm_role_definition" "alz" {
  for_each           = { for r in var.role_definitions : r.name => r }
  role_definition_id = each.key
  name               = each.value.role_name
  description        = each.value.description
  scope              = local.management_group_ids[local.root_id]
  assignable_scopes  = [local.management_group_ids[local.root_id]]

  dynamic "permissions" {
    for_each = each.value.permissions
    content {
      actions          = permissions.value.actions
      not_actions      = permissions.value.not_actions
      data_actions     = permissions.value.data_actions
      not_data_actions = permissions.value.not_data_actions
    }
  }
}

# --- Privileged Identity Management ---------------------------------------------

locals {
  pim_approver = lookup(var.policy_values, "pim_approver_group_id", "")
  pim_policies = var.pim == null ? {} : {
    for pair in setproduct(keys(local.management_groups), var.pim.roles) : "\${pair[0]}/\${pair[1].name}" => { management_group_id = pair[0], role = pair[1] }
  }
  # Eligible assignments whose group object ID is set.
  pim_eligibilities = var.pim == null ? {} : {
    for e in var.pim.eligibilities : "\${e.management_group_id}/\${e.name}" => e if lookup(var.policy_values, e.input, "") != ""
  }
}

# Role settings for the privileged roles at every management group.
resource "azurerm_role_management_policy" "pim" {
  for_each           = local.pim_policies
  scope              = local.management_group_ids[each.value.management_group_id]
  role_definition_id = "\${local.management_group_ids[each.value.management_group_id]}/providers/Microsoft.Authorization/roleDefinitions/\${each.value.role.role_definition_id}"

  activation_rules {
    maximum_duration                   = var.pim.activation_maximum_duration
    require_approval                   = each.value.role.require_approval && local.pim_approver != ""
    require_multifactor_authentication = var.pim.require_mfa
    require_justification              = var.pim.require_justification
    require_ticket_info                = var.pim.require_ticket

    dynamic "approval_stage" {
      for_each = each.value.role.require_approval && local.pim_approver != "" ? [1] : []
      content {
        primary_approver {
          object_id = local.pim_approver
          type      = "Group"
        }
      }
    }
  }

  # No permanent eligible or active assignments.
  eligible_assignment_rules {
    expiration_required = true
    expire_after        = var.pim.eligible_expire_after
  }

  active_assignment_rules {
    expiration_required                = true
    expire_after                       = var.pim.active_expire_after
    require_multifactor_authentication = var.pim.require_mfa
    require_justification              = var.pim.require_justification
  }

  notification_rules {
    eligible_activations {
      admin_notifications {
        notification_level = "All"
        default_recipients = true
      }
    }
    eligible_assignments {
      admin_notifications {
        notification_level = "All"
        default_recipients = true
      }
    }
    active_assignments {
      admin_notifications {
        notification_level = "All"
        default_recipients = true
      }
    }
  }

  # Settings for a custom role need the role first.
  depends_on = [azurerm_role_definition.alz]
}

# Groups that can activate a privileged role just in time.
resource "azurerm_pim_eligible_role_assignment" "pim" {
  for_each           = local.pim_eligibilities
  scope              = local.management_group_ids[each.value.management_group_id]
  role_definition_id = "\${local.management_group_ids[each.value.management_group_id]}/providers/Microsoft.Authorization/roleDefinitions/\${each.value.role_definition_id}"
  principal_id       = var.policy_values[each.value.input]
  justification      = "\${each.value.name}: eligible by design (Azure Governance Planner)."

  schedule {
    expiration {
      duration_days = var.pim.eligible_duration_days
    }
  }

  depends_on = [azurerm_role_management_policy.pim]
}

# Exemptions, at their scope.
locals {
  exemptions = { for e in var.policy_exemptions : "\${e.scope_kind}/\${coalesce(e.scope_management_group_id, e.scope_subscription_id, "-")}/\${coalesce(e.scope_resource_group_name, "-")}/\${e.name}" => e }
  exemption_assignment_id = {
    for k, e in local.exemptions : k => azurerm_management_group_policy_assignment.this["\${e.management_group_id}/\${e.assignment}"].id
  }
}

resource "azurerm_management_group_policy_exemption" "this" {
  for_each                        = { for k, e in local.exemptions : k => e if e.scope_kind == "managementGroup" }
  name                            = each.value.name
  display_name                    = each.value.display_name
  description                     = each.value.description
  management_group_id             = local.management_group_ids[each.value.scope_management_group_id]
  policy_assignment_id            = local.exemption_assignment_id[each.key]
  policy_definition_reference_ids = each.value.policy_definition_reference_ids
  exemption_category              = each.value.category
  expires_on                      = each.value.expires_on
}

resource "azurerm_subscription_policy_exemption" "this" {
  for_each                        = { for k, e in local.exemptions : k => e if e.scope_kind == "subscription" }
  name                            = each.value.name
  display_name                    = each.value.display_name
  description                     = each.value.description
  subscription_id                 = "/subscriptions/\${each.value.scope_subscription_id}"
  policy_assignment_id            = local.exemption_assignment_id[each.key]
  policy_definition_reference_ids = each.value.policy_definition_reference_ids
  exemption_category              = each.value.category
  expires_on                      = each.value.expires_on
}

resource "azurerm_resource_group_policy_exemption" "this" {
  for_each                        = { for k, e in local.exemptions : k => e if e.scope_kind == "resourceGroup" }
  name                            = each.value.name
  display_name                    = each.value.display_name
  description                     = each.value.description
  resource_group_id               = "/subscriptions/\${each.value.scope_subscription_id}/resourceGroups/\${each.value.scope_resource_group_name}"
  policy_assignment_id            = local.exemption_assignment_id[each.key]
  policy_definition_reference_ids = each.value.policy_definition_reference_ids
  exemption_category              = each.value.category
  expires_on                      = each.value.expires_on
}

output "management_group_ids" {
  description = "Resource IDs of the management groups, by name."
  value       = local.management_group_ids
}
`;
}

/** A JSON value as an HCL expression (for jsonencode). */
function hclJson(value: unknown, indent = ''): string {
  const next = indent + '  ';
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => `${next}${hclJson(v, next)},`).join('\n')}\n${indent}]` : '[]';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [k, hclJson(v, next)] as const);
    if (!entries.length) return '{}';
    // As terraform fmt does: runs of single-line values are aligned; a multi-line value ends the run.
    const lines: string[] = [];
    let run: (readonly [string, string])[] = [];
    const flush = () => {
      const width = Math.max(0, ...run.map(([k]) => k.length));
      for (const [k, v] of run) lines.push(`${next}${k.padEnd(width)} = ${v}`);
      run = [];
    };
    for (const entry of entries) {
      if (entry[1].includes('\n')) {
        flush();
        lines.push(`${next}${entry[0]} = ${entry[1]}`);
      } else run.push(entry);
    }
    flush();
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  return typeof value === 'string' ? tq(value) : String(value);
}

const jsonString = (value: unknown) => (value === undefined || value === null ? undefined : JSON.stringify(value));

/** The design as Terraform variable values (design.auto.tfvars.json / Terragrunt design.json). */
export function toTerraformDesign(model: IacModel, options: ExportOptions): string {
  const platform = platformFor(model, options);
  return json({
    management_groups: model.managementGroups.map((m) => ({ id: m.id, display_name: m.displayName, parent_id: m.parentId })),
    policy_definitions: model.policyDefinitions.map((d) => ({
      name: d.name,
      display_name: d.properties.displayName ?? d.name,
      description: d.properties.description,
      mode: d.properties.mode ?? 'All',
      metadata: jsonString(d.properties.metadata),
      parameters: d.properties.parameters && Object.keys(d.properties.parameters).length ? jsonString(d.properties.parameters) : undefined,
      policy_rule: JSON.stringify(d.properties.policyRule),
    })),
    policy_set_definitions: model.policySetDefinitions.map((s) => ({
      name: s.name,
      display_name: s.properties.displayName ?? s.name,
      description: s.properties.description,
      metadata: jsonString(s.properties.metadata),
      parameters: s.properties.parameters && Object.keys(s.properties.parameters).length ? jsonString(s.properties.parameters) : undefined,
      policy_definitions: (s.properties.policyDefinitions ?? []).map((r) => ({
        policy_definition_id: r.policyDefinitionId,
        reference_id: r.policyDefinitionReferenceId,
        parameter_values: r.parameters && Object.keys(r.parameters).length ? JSON.stringify(r.parameters) : undefined,
        policy_group_names: r.groupNames ?? [],
      })),
      policy_definition_groups: (s.properties.policyDefinitionGroups ?? []).map((g) => ({
        name: g.name,
        display_name: g.displayName,
        category: g.category,
        description: g.description,
      })),
    })),
    platform_resources: {
      log_analytics_workspace: model.platform.logAnalyticsWorkspace,
      user_assigned_identity: model.platform.userAssignedIdentity,
      data_collection_rules: model.platform.dataCollectionRules,
      private_dns_resource_group: model.platform.privateDnsResourceGroup,
      private_dns_zones: platform.privateDnsZones,
    },
    subscription_placements: placementsFor(model, options).map((p) => ({ management_group_id: p.managementGroupId, input: p.input })),
    platform_role_assignments: model.platformRoleAssignments.map((g) => ({
      management_group_id: g.managementGroupId,
      assignment: g.assignment,
      role_definition_id: g.roleDefinitionId,
      scope: g.scope,
    })),
    policy_assignments: model.assignments.map((a) => ({
      overrides: chunks(disabledReferenceIds(a, options), OVERRIDE_REFS).map((ids) => ({ value: 'Disabled', reference_ids: ids })),
      management_group_id: a.managementGroupId,
      name: a.name,
      display_name: a.displayName,
      description: a.description,
      policy_definition_id: a.policyDefinitionId,
      enforce: a.enforcementMode === 'Default',
      identity: a.identity,
      parameters: JSON.stringify(a.parameters),
      inputs: a.inputs,
      non_compliance_messages: a.nonComplianceMessages.map((m) => ({
        content: m.message,
        policy_definition_reference_id: m.policyDefinitionReferenceId,
      })),
      role_definition_ids: a.roleDefinitionIds,
      not_scopes: a.notScopes,
    })),
    policy_exemptions: model.exemptions.map((e) => ({
      name: e.name,
      display_name: e.displayName,
      description: e.description || undefined,
      management_group_id: e.managementGroupId,
      assignment: e.assignment,
      scope_kind: e.scope.kind,
      scope_management_group_id: e.scope.kind === 'managementGroup' ? e.scope.managementGroupId : undefined,
      scope_subscription_id: e.scope.kind !== 'managementGroup' ? e.scope.subscriptionId : undefined,
      scope_resource_group_name: e.scope.kind === 'resourceGroup' ? e.scope.resourceGroupName : undefined,
      policy_definition_reference_ids: e.policyDefinitionReferenceIds,
      category: e.category,
      expires_on: e.expiresOn ?? undefined,
    })),
    cloud_environment: model.cloud,
    role_definitions: model.roleDefinitions.map((r) => ({
      name: r.name,
      role_name: r.roleName,
      description: r.description,
      permissions: r.permissions.map((p) => ({
        actions: p.actions,
        not_actions: p.notActions,
        data_actions: p.dataActions,
        not_data_actions: p.notDataActions,
      })),
    })),
    pim: model.pim
      ? {
          activation_maximum_duration: model.pim.activationMaximumDuration,
          require_mfa: model.pim.requireMfa,
          require_justification: model.pim.requireJustification,
          require_ticket: model.pim.requireTicket,
          eligible_expire_after: model.pim.eligibleExpireAfter,
          active_expire_after: model.pim.activeExpireAfter,
          eligible_duration_days: model.pim.eligibleDurationDays,
          roles: model.pim.roles.map((r) => ({ name: r.name, role_definition_id: r.roleDefinitionId, require_approval: r.requireApproval })),
          eligibilities: model.pim.eligibilities.map((e) => ({
            name: e.name,
            role_definition_id: e.roleDefinitionId,
            management_group_id: e.managementGroupId,
            input: e.input,
          })),
        }
      : undefined,
    hierarchy_settings: model.hierarchySettings
      ? {
          default_management_group_id: model.hierarchySettings.defaultManagementGroupId,
          require_authorization_for_group_creation: model.hierarchySettings.requireAuthorizationForGroupCreation,
        }
      : undefined,
  });
}

/** [name, value, input it repeats] for each alias. */
function aliasLines(model: IacModel, options: ExportOptions): [string, string, string][] {
  return Object.entries(model.aliases).map(([name, of]) => {
    const input = model.inputs.find((i) => i.name === of);
    return [name, input ? inputValue(input, model, options) : '', of];
  });
}

/** Azure allows 10 overrides per assignment, each for up to 50 policy reference IDs. */
const OVERRIDE_REFS = 50;
const MAX_OVERRIDES = 10;

/** The reference IDs an assignment's overrides turn off, for these options. */
export function disabledReferenceIds(a: IacAssignment, options: ExportOptions): string[] {
  return options.excludeManualControls ? a.manualReferenceIds.slice(0, OVERRIDE_REFS * MAX_OVERRIDES) : [];
}

/** How many manual policies the option turns off, and in how many assignments. */
export function manualPolicyCount(model: IacModel): { policies: number; assignments: number; capped: string[] } {
  const withManual = model.assignments.filter((a) => a.manualReferenceIds.length);
  return {
    policies: withManual.reduce((n, a) => n + Math.min(a.manualReferenceIds.length, OVERRIDE_REFS * MAX_OVERRIDES), 0),
    assignments: withManual.length,
    capped: withManual.filter((a) => a.manualReferenceIds.length > OVERRIDE_REFS * MAX_OVERRIDES).map((a) => a.name),
  };
}

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** Assignments as the files carry them: the manual reference IDs become effect overrides when the option is on. */
function assignmentsFor(model: IacModel, options: ExportOptions) {
  return model.assignments.map((a) => {
    const { manualReferenceIds, ...rest } = a;
    return {
      ...rest,
      overrides: chunks(disabledReferenceIds(a, options), OVERRIDE_REFS).map((ids) => ({
        kind: 'policyEffect',
        value: 'Disabled',
        selectors: [{ kind: 'policyDefinitionReferenceId', in: ids }],
      })),
    };
  });
}

/** Placements for the files: none when the option is off. */
const placementsFor = (model: IacModel, options: ExportOptions) => (options.placeSubscriptions === false ? [] : model.subscriptionPlacements);

/** location and policy_values as HCL attribute lines. */
function terraformValues(model: IacModel, options: ExportOptions): string[] {
  const location = model.inputs.find((i) => i.name === 'location');
  const values = model.inputs.filter((i) => i.name !== 'location');
  const unset = new Set(unsetInputs(model, options).map((i) => i.name));
  return [
    `location = ${tq(location ? inputValue(location, model, options) : 'eastus2')}`,
    '',
    'policy_values = {',
    ...values.flatMap((i) => [
      `  # ${i.description}${unset.has(i.name) ? ' SET THIS: still the ALZ placeholder.' : ''}`,
      `  ${i.name} = ${tq(inputValue(i, model, options))}`,
    ]),
    ...aliasLines(model, options).flatMap(([name, value, of]) => [`  # Same as ${of}.`, `  ${name} = ${tq(value)}`]),
    '}',
  ];
}

export function toTfvars(model: IacModel, options: ExportOptions): string {
  const env = environmentOf(options);
  return `${commentBlock('#', [
    `${model.rootName}, ${env} environment. ${GENERATOR}`,
    '',
    ...summaryLines(model),
    '',
    `  terraform apply -var-file=${env}.tfvars`,
  ])}
${terraformValues(model, options).join('\n')}
`;
}

// --- Terragrunt ----------------------------------------------------------------

const terragruntLiveDir = (env: string) => `live/${env}/governance`;

export function toTerragruntRoot(): string {
  return `${commentBlock('#', [
    'Shared Terragrunt settings, included by every live/<env>/<stack>/terragrunt.hcl.',
    GENERATOR,
    '',
    'State is kept in an Azure Storage account named by environment variables:',
    '  ARM_SUBSCRIPTION_ID        subscription for state and the provider',
    '  TG_STATE_RESOURCE_GROUP    resource group of the state storage account',
    '  TG_STATE_STORAGE_ACCOUNT   state storage account',
    '  TG_STATE_CONTAINER         blob container (default: tfstate)',
  ])}
locals {
  state_resource_group  = get_env("TG_STATE_RESOURCE_GROUP")
  state_storage_account = get_env("TG_STATE_STORAGE_ACCOUNT")
  state_container       = get_env("TG_STATE_CONTAINER", "tfstate")
}

remote_state {
  backend = "azurerm"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    resource_group_name  = local.state_resource_group
    storage_account_name = local.state_storage_account
    container_name       = local.state_container
    key                  = "\${path_relative_to_include()}/terraform.tfstate"
    use_azuread_auth     = true
  }
}

# The azurerm provider reads the subscription from ARM_SUBSCRIPTION_ID.
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "azurerm" {
  environment = var.cloud_environment
  features {}
}
EOF
}
`;
}

export function toTerragruntLive(model: IacModel, options: ExportOptions): string {
  const env = environmentOf(options);
  return `${commentBlock('#', [
    `${model.rootName}, ${env} environment. ${GENERATOR}`,
    '',
    ...summaryLines(model),
    '',
    `  cd ${terragruntLiveDir(env)}`,
    '  terragrunt apply',
    '',
    'The design is in design.json; the per-environment values are below.',
  ])}
include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "\${get_parent_terragrunt_dir("root")}/modules//governance"
}

inputs = merge(jsondecode(file("\${get_terragrunt_dir()}/design.json")), {
${terraformValues(model, options)
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
})
`;
}

// --- READMEs -------------------------------------------------------------------

function prerequisites(model: IacModel, options: ExportOptions): string {
  const unset = unsetInputs(model, options);
  return `## Before you deploy

- **Permissions.** Creating management groups under the tenant root group, policy definitions and
  role assignments needs Owner (or Management Group Contributor plus Resource Policy Contributor and
  User Access Administrator) at the tenant root management group.
${platformSection(model)}- **Values.** Set the subscriptions and resource IDs in the values file first.${
    unset.length ? ` Still empty or at the ALZ placeholder: ${unset.map((i) => `\`${i.name}\``).join(', ')}.` : ''
  }
${rolesSection(model)}${manualSection(model, options)}${pimSection(model)}${hierarchySection(model)}${placementSection(model, options)}- **Remediation.** New assignments only apply to new and updated resources. Create remediation tasks
  for existing resources after the managed identities' role assignments have replicated.
- **Cross-scope roles.** Remediation identities also get their policies' roles on the resource groups
  their parameters point at (${platformScopes(model)}), as the ALZ Terraform module grants them.
`;
}

const RULE_LABEL: Record<DataCollectionRule, string> = {
  vmInsights: 'VM Insights',
  changeTracking: 'Change Tracking and Inventory',
  defenderSql: 'Defender for SQL',
};

/** What the export creates for the policies to point at. */
function platformSection(model: IacModel): string {
  const { platform } = model;
  const management = [
    platform.logAnalyticsWorkspace && 'a Log Analytics workspace (with the solutions its data needs)',
    platform.userAssignedIdentity && 'the user-assigned identity Azure Monitor Agent authenticates with',
    platform.dataCollectionRules.length &&
      `data collection rules for ${platform.dataCollectionRules.map((r) => RULE_LABEL[r]).join(', ')}`,
  ].filter(Boolean);
  const lines = [
    management.length &&
      `  - in the management subscription, a resource group with ${management.join(', ')}. The policies' parameters point at them;`,
    platform.privateDnsResourceGroup &&
      `  - in the private DNS zone subscription, the resource group for the private link DNS zones${
        platform.privateDnsZones.length
          ? `, with ${platform.privateDnsZones.length} zones (${platform.privateDnsZones.join(', ')}). Link them to your hub virtual network(s); ALZ's policy adds the private endpoint records`
          : '. Create the zones in it: the policy adds records to them, it does not create them'
      };`,
  ].filter(Boolean);
  return lines.length ? `- **Platform resources.** The export creates:\n${lines.join('\n')}\n` : '';
}

function rolesSection(model: IacModel): string {
  if (!model.roleDefinitions.length) return '';
  return `- **Custom roles.** ALZ's custom roles are defined at \`${model.managementGroups[0].id}\` and assignable anywhere under it:
  ${model.roleDefinitions.map((r) => `\`${r.roleName}\``).join(', ')}. Their IDs are fixed (UUID v5 of the top management group
  and the role name), so redeploying updates them in place.
`;
}

function manualSection(model: IacModel, options: ExportOptions): string {
  if (!options.excludeManualControls) return '';
  const { policies, assignments, capped } = manualPolicyCount(model);
  if (!policies) return '';
  return `- **Manual-only controls excluded.** ${policies} manual-attestation policies in ${assignments} initiative assignment${assignments === 1 ? '' : 's'} are
  turned off with effect overrides (Disabled), so controls they alone covered aren't evaluated or listed as needing evidence.
  Controls with automated policies keep them.${capped.length ? ` Azure allows 500 overrides per assignment, so ${capped.join(', ')} keep some manual policies.` : ''}
`;
}

function pimSection(model: IacModel): string {
  const p = model.pim;
  if (!p) return '';
  const approval = p.roles.filter((r) => r.requireApproval).map((r) => r.name);
  return `- **Privileged Identity Management (${p.profile} profile).** ${p.roles.map((r) => r.name).join(', ')} at every management group:
  activations up to ${p.activationMaximumDuration.replace('PT', '').toLowerCase()}, with MFA and justification${p.requireTicket ? ' and a ticket number' : ''};
  approval for ${approval.join(', ') || 'none'} (by \`pim_approver_group_id\`); eligible assignments expire after
  ${p.eligibleExpireAfter.slice(1, -1)} days and active ones after ${p.activeExpireAfter.slice(1, -1)}, so nothing is permanent. Eligible groups:
${p.eligibilities.map((e) => `  - ${e.name}: ${e.roleName} at \`${e.managementGroupId}\` (\`${e.input}\`)`).join('\n') || '  - none'}
  PIM needs Entra ID P2 (or Entra ID Governance). Remove standing Owner and access-administrator assignments once the
  eligible ones work, but keep two emergency access (break-glass) accounts outside PIM. Set up ${p.accessReview} access
  reviews of the eligible assignments in Entra ID (Identity Governance), which the export doesn't create.${
    model.policyDefinitions !== undefined ? '' : ''
  }
`;
}

function hierarchySection(model: IacModel): string {
  const h = model.hierarchySettings;
  if (!h) return '';
  const locked = model.policyDefinitions.some((d) => d.name === PARKING_LOT_POLICY);
  return `- **Parking lot.** The export sets the tenant's default management group to \`${h.defaultManagementGroupId}\`, so new
  subscriptions land there instead of the tenant root group${
    h.requireAuthorizationForGroupCreation ? ', and requires permission on the tenant root group to create management groups' : ''
  }. Changing these tenant settings needs Owner on the tenant root group.${
    locked
      ? `
  The parking lot is locked: \`${PARKING_LOT_POLICY}\` denies every resource type, resource groups included, apart from
  the platform security baseline (${PARKING_LOT_ALLOWED_TYPES.map((t) => `\`${t}\``).join(', ')}). Moving a
  subscription in or out isn't a deployment, so it still works: it needs Owner on the subscription and Management Group
  Contributor on both groups, so keep those roles to the people who place subscriptions.`
      : ''
  }
`;
}

function placementSection(model: IacModel, options: ExportOptions): string {
  const placements = placementsFor(model, options);
  if (!placements.length) return '';
  const list = placements.map((p) => `\`${p.input}\` into \`${p.managementGroupId}\``).join(', ');
  return `- **Subscriptions.** The export moves ${list}, so those management groups' assignments apply. Moving a
  subscription needs Owner on it and on its current management group, and it picks up the new group's policies straight away.
`;
}

function platformScopes(model: IacModel): string {
  const scopes = [...new Set(model.platformRoleAssignments.map((g) => g.scope))].map((s) =>
    s === 'management'
      ? 'the management resource group'
      : s === 'privateDns'
        ? 'the private DNS zone resource group'
        : `the resource group of \`${s}\``,
  );
  return scopes.length ? scopes.join(', ') : 'none in this design';
}

function notesSection(model: IacModel): string {
  return model.notes.length ? `\n## Notes\n\n${model.notes.map((n) => `- ${n}`).join('\n')}\n` : '';
}

function bicepReadme(model: IacModel, options: ExportOptions): string {
  const env = environmentOf(options);
  return `# ${model.rootName}: Azure governance (Bicep)

${GENERATOR} ${summaryLines(model).join(' ')}

\`\`\`
main.bicep                        generic template (tenant scope)
modules/policy-definitions.bicep  custom definitions and initiatives at the top management group
modules/policy-assignments.bicep  assignments and identity role assignments at one management group
${`${env}.bicepparam`.padEnd(34)}this environment's values; loads the design from lib/
lib/                              the design as data
\`\`\`

## Deploy

\`\`\`sh
${model.cloud === 'usgovernment' ? 'az cloud set --name AzureUSGovernment\n' : ''}az login
az deployment tenant what-if --location <region> --parameters ${env}.bicepparam
az deployment tenant create --name governance-${env} --location <region> --parameters ${env}.bicepparam
${model.pim ? 'bash scripts/set-pim-policies.sh   # PIM role settings (needs jq)\n' : ''}\`\`\`

${prerequisites(model, options)}${notesSection(model)}`;
}

function terraformReadme(model: IacModel, options: ExportOptions): string {
  const env = environmentOf(options);
  return `# ${model.rootName}: Azure governance (Terraform)

${GENERATOR} ${summaryLines(model).join(' ')}

\`\`\`
main.tf                   generic module; every input is a variable
design.auto.tfvars.json   the design as data (loaded automatically)
${`${env}.tfvars`.padEnd(26)}this environment's values
\`\`\`

## Deploy

\`\`\`sh
${model.cloud === 'usgovernment' ? 'az cloud set --name AzureUSGovernment\n' : ''}az login
export ARM_SUBSCRIPTION_ID=<any subscription in the tenant>
terraform init
terraform plan -var-file=${env}.tfvars
terraform apply -var-file=${env}.tfvars
\`\`\`

${prerequisites(model, options)}${notesSection(model)}`;
}

function terragruntReadme(model: IacModel, options: ExportOptions): string {
  const live = terragruntLiveDir(environmentOf(options));
  return `# ${model.rootName}: Azure governance (Terragrunt)

${GENERATOR} ${summaryLines(model).join(' ')}

\`\`\`
root.hcl                     shared remote state (Azure Storage) and azurerm provider
modules/governance/main.tf   generic module; every input is a variable
${live}/
  terragrunt.hcl             this environment: the module source and its values
  design.json                the design as data
\`\`\`

## Deploy

\`\`\`sh
${model.cloud === 'usgovernment' ? 'az cloud set --name AzureUSGovernment\n' : ''}az login
export ARM_SUBSCRIPTION_ID=<subscription id>
export TG_STATE_RESOURCE_GROUP=<state resource group>
export TG_STATE_STORAGE_ACCOUNT=<state storage account>
export TG_STATE_CONTAINER=tfstate   # optional

cd ${live}
terragrunt plan
terragrunt apply
\`\`\`

The state storage account and container must already exist, and your identity needs the
Storage Blob Data Contributor role on them (state uses Entra ID auth).

${prerequisites(model, options)}
## Another environment

Copy \`${live}\` to \`live/<env>/governance\` and change the values in its \`terragrunt.hcl\`.
${notesSection(model)}`;
}

// --- Files ---------------------------------------------------------------------

/** Every file of a format, with paths relative to the format's export folder. */
export function generateIacFiles(format: IacFormat, model: IacModel, options: ExportOptions): IacFile[] {
  const env = environmentOf(options);
  switch (format) {
    case 'bicep':
      return [
        { name: 'main.bicep', content: toBicep(), description: 'generic template' },
        { name: `${env}.bicepparam`, content: toBicepParams(model, options), description: 'values for this environment' },
        { name: 'modules/policy-definitions.bicep', content: toBicepDefinitionsModule(), description: 'module' },
        { name: 'modules/policy-assignments.bicep', content: toBicepAssignmentsModule(), description: 'module' },
        { name: 'modules/management-resources.bicep', content: toBicepManagementModule(), description: 'module' },
        { name: 'modules/resource-group.bicep', content: toBicepResourceGroupModule(), description: 'module' },
        { name: 'modules/private-dns-zones.bicep', content: toBicepPrivateDnsZonesModule(), description: 'module' },
        { name: 'modules/role-assignment.bicep', content: toBicepRoleAssignmentModule(), description: 'module' },
        { name: 'modules/policy-exemption-mg.bicep', content: toBicepExemptionModule('managementGroup'), description: 'module' },
        { name: 'modules/policy-exemption-subscription.bicep', content: toBicepExemptionModule('subscription'), description: 'module' },
        { name: 'modules/policy-exemption-rg.bicep', content: toBicepExemptionModule('resourceGroup'), description: 'module' },
        { name: 'lib/management-groups.json', content: json(model.managementGroups), description: 'design' },
        { name: 'lib/platform-resources.json', content: json(platformFor(model, options)), description: 'design' },
        { name: 'lib/platform-role-assignments.json', content: json(model.platformRoleAssignments), description: 'design' },
        { name: 'lib/subscription-placements.json', content: json(placementsFor(model, options)), description: 'design' },
        { name: 'lib/policy-assignments.json', content: json(assignmentsFor(model, options)), description: 'design' },
        { name: 'lib/policy-exemptions.json', content: json(model.exemptions), description: 'design' },
        { name: 'lib/hierarchy-settings.json', content: json(model.hierarchySettings ?? {}), description: 'design' },
        { name: 'lib/pim.json', content: json(model.pim ?? {}), description: 'design' },
        { name: 'lib/role-definitions.json', content: json(model.roleDefinitions), description: 'design' },
        { name: 'modules/role-definitions.bicep', content: toBicepRoleDefinitionsModule(), description: 'module' },
        ...(model.pim
          ? [
              { name: 'modules/pim-eligibility.bicep', content: toBicepPimModule(), description: 'module' },
              { name: 'scripts/set-pim-policies.sh', content: toPimPolicyScript(model, options), description: 'PIM role settings' },
            ]
          : []),
        { name: 'lib/policy-set-definitions.json', content: json(model.policySetDefinitions), description: 'design' },
        { name: 'lib/policy-definitions.json', content: json(model.policyDefinitions), description: 'design' },
        { name: 'README.md', content: bicepReadme(model, options), description: 'how to deploy' },
      ];
    case 'terraform':
      return [
        { name: 'main.tf', content: toTerraform(), description: 'generic module' },
        { name: `${env}.tfvars`, content: toTfvars(model, options), description: 'values for this environment' },
        { name: 'design.auto.tfvars.json', content: toTerraformDesign(model, options), description: 'design' },
        { name: 'README.md', content: terraformReadme(model, options), description: 'how to deploy' },
      ];
    case 'terragrunt':
      return [
        { name: 'root.hcl', content: toTerragruntRoot(), description: 'shared state and provider' },
        { name: 'modules/governance/main.tf', content: toTerraform({ terragrunt: true }), description: 'generic module' },
        { name: `${terragruntLiveDir(env)}/terragrunt.hcl`, content: toTerragruntLive(model, options), description: 'values for this environment' },
        { name: `${terragruntLiveDir(env)}/design.json`, content: toTerraformDesign(model, options), description: 'design' },
        { name: 'README.md', content: terragruntReadme(model, options), description: 'how to deploy' },
      ];
  }
}
