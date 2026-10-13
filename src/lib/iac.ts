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
import type { Design, PlannedAssignment } from './engine';

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
    policyRule?: { then?: { details?: { roleDefinitionIds?: string[] } } };
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
}

export interface IacModel {
  rootName: string;
  alzRef: string;
  managementGroups: IacManagementGroup[];
  policyDefinitions: ArmDefinition[];
  policySetDefinitions: ArmDefinition[];
  assignments: IacAssignment[];
  inputs: IacInput[];
  /** Things the export changed or left out. */
  notes: string[];
}

export interface ExportOptions {
  environment: string;
  /** Values for the model's inputs, by name; empty or missing means the placeholder. */
  values: Record<string, string>;
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
      if (a.definitionSource === 'Custom') sets.set(a.name, frameworkEnforcementSet(a));

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
      } else if (a.parameters) {
        parameters = Object.fromEntries(Object.entries(a.parameters).map(([k, value]) => [k, { value }]));
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
      });
      if (a.identity) useInput('location', a.name);
    }
  }
  if (missing.size) notes.push(`Not found in ALZ library ${library.ref}: ${[...missing].join(', ')}.`);
  if (droppedPlaceholders)
    notes.push(
      `${droppedPlaceholders} ALZ placeholder parameter values were left out so the definitions' defaults apply (for private DNS, the zone IDs are built from the DNS subscription, resource group and region).`,
    );

  const location = design.input.allowedLocations.map((l) => l.trim()).find(Boolean) ?? 'eastus2';
  if (!inputUse.has('location')) inputUse.set('location', new Set());
  const describe = new Map(library.defaults.map((d) => [d.default_name, d.description]));
  const inputs: IacInput[] = [...inputUse].map(([name, users]) => ({
    name,
    description:
      name === 'location'
        ? 'Region for the policy assignments’ managed identities and the resources their remediation deploys.'
        : (describe.get(name) ?? name),
    placeholder:
      name === 'location' || name === 'private_dns_zone_region'
        ? location
        : (placeholders.get(name) ?? '').replace(LOCATION_TOKEN, location),
    usedBy: [...users],
  }));
  inputs.sort((a, b) => (a.name === 'location' ? -1 : b.name === 'location' ? 1 : a.name.localeCompare(b.name)));

  return {
    rootName: root.displayName,
    alzRef: library.ref,
    managementGroups,
    policyDefinitions: [...definitions.values()],
    policySetDefinitions: [...sets.values()],
    assignments,
    inputs,
    notes,
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

/** The value an input deploys with. */
export function inputValue(input: IacInput, options: ExportOptions): string {
  return options.values[input.name]?.trim() || input.placeholder;
}

/** Inputs still at an ALZ placeholder (or empty), which deploy but point at nothing. */
export function unsetInputs(model: IacModel, options: ExportOptions): IacInput[] {
  return model.inputs.filter((i) => {
    const v = inputValue(i, options);
    return !v || PLACEHOLDER.test(v) || /replace_me|^defaultString/i.test(v);
  });
}

// --- Shared ------------------------------------------------------------------

const GENERATOR = 'Generated by Azure Governance Planner.';

function commentBlock(prefix: string, lines: string[]): string {
  return lines.map((l) => (l ? `${prefix} ${l}` : prefix)).join('\n') + '\n';
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

const environmentOf = (options: ExportOptions) => options.environment.trim().replace(/[^A-Za-z0-9_-]+/g, '-') || 'prod';

function summaryLines(model: IacModel): string[] {
  return [
    `${model.managementGroups.length} management groups under ${model.rootName}, ${model.policyDefinitions.length} custom policy definitions,`,
    `${model.policySetDefinitions.length} custom initiatives, ${model.assignments.length} policy assignments and`,
    `${model.assignments.reduce((n, a) => n + a.roleDefinitionIds.length, 0)} role assignments for their managed identities.`,
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

var rootId = managementGroups[0].id
var defaultParent = empty(parentManagementGroupId) ? tenant().tenantId : parentManagementGroupId

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
      policyValues: union(policyValues, { location: location })
      policyAssignments: filter(policyAssignments, a => a.managementGroupId == mg.id)
    }
    dependsOn: [definitions]
  }
]

output managementGroupIds array = [for (mg, i) in managementGroups: mgs[i].id]
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
`;
}

export function toBicepParams(model: IacModel, options: ExportOptions): string {
  const env = environmentOf(options);
  const location = model.inputs.find((i) => i.name === 'location');
  const values = model.inputs.filter((i) => i.name !== 'location');
  const unset = new Set(unsetInputs(model, options).map((i) => i.name));
  const lines = values.flatMap((i) => [
    `  // ${i.description}${unset.has(i.name) ? ' SET THIS: still the ALZ placeholder.' : ''}`,
    `  ${i.name}: ${bicepString(inputValue(i, options))}`,
  ]);
  return `${commentBlock('//', [
    `${model.rootName}, ${env} environment. ${GENERATOR}`,
    '',
    ...summaryLines(model),
    '',
    'Deploy:',
    `  az deployment tenant create --name governance-${env} --location ${location ? inputValue(location, options) : 'eastus2'} --parameters ${env}.bicepparam`,
  ])}
using 'main.bicep'

param location = ${bicepString(location ? inputValue(location, options) : 'eastus2')}

param policyValues = {
${lines.join('\n')}
}

// The design, as data.
param managementGroups = loadJsonContent('lib/management-groups.json')
param policyDefinitions = loadJsonContent('lib/policy-definitions.json')
param policySetDefinitions = loadJsonContent('lib/policy-set-definitions.json')
param policyAssignments = loadJsonContent('lib/policy-assignments.json')
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
  }
}
${provider}
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
  }))
  default = []
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

locals {
  policy_values = merge(var.policy_values, { location = var.location })
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

  dynamic "non_compliance_message" {
    for_each = each.value.non_compliance_messages
    content {
      content                        = non_compliance_message.value.content
      policy_definition_reference_id = non_compliance_message.value.policy_definition_reference_id
    }
  }

  depends_on = [azurerm_policy_definition.this, azurerm_management_group_policy_set_definition.this]
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

output "management_group_ids" {
  description = "Resource IDs of the management groups, by name."
  value       = local.management_group_ids
}
`;
}

const jsonString = (value: unknown) => (value === undefined || value === null ? undefined : JSON.stringify(value));

/** The design as Terraform variable values (design.auto.tfvars.json / Terragrunt design.json). */
export function toTerraformDesign(model: IacModel): string {
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
    policy_assignments: model.assignments.map((a) => ({
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
    })),
  });
}

/** location and policy_values as HCL attribute lines. */
function terraformValues(model: IacModel, options: ExportOptions): string[] {
  const location = model.inputs.find((i) => i.name === 'location');
  const values = model.inputs.filter((i) => i.name !== 'location');
  const unset = new Set(unsetInputs(model, options).map((i) => i.name));
  return [
    `location = ${tq(location ? inputValue(location, options) : 'eastus2')}`,
    '',
    'policy_values = {',
    ...values.flatMap((i) => [
      `  # ${i.description}${unset.has(i.name) ? ' SET THIS: still the ALZ placeholder.' : ''}`,
      `  ${i.name} = ${tq(inputValue(i, options))}`,
    ]),
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
- **Platform resources.** ALZ's DeployIfNotExists policies point at resources this export doesn't
  create, such as the central Log Analytics workspace. Set their IDs in the values file first.${
    unset.length
      ? ` Still at the ALZ placeholder: ${unset.map((i) => `\`${i.name}\``).join(', ')}.`
      : ''
  }
- **Remediation.** New assignments only apply to new and updated resources. Create remediation tasks
  for existing resources after the managed identities' role assignments have replicated.
- **Cross-scope roles.** Some ALZ assignments remediate outside their own management group (for
  example, private DNS records in the connectivity subscription). Grant their identities a role on
  that scope as well, as the ALZ Terraform module does.
`;
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
az login
az deployment tenant what-if --location <region> --parameters ${env}.bicepparam
az deployment tenant create --name governance-${env} --location <region> --parameters ${env}.bicepparam
\`\`\`

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
az login
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
az login
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
        { name: 'lib/management-groups.json', content: json(model.managementGroups), description: 'design' },
        { name: 'lib/policy-assignments.json', content: json(model.assignments), description: 'design' },
        { name: 'lib/policy-set-definitions.json', content: json(model.policySetDefinitions), description: 'design' },
        { name: 'lib/policy-definitions.json', content: json(model.policyDefinitions), description: 'design' },
        { name: 'README.md', content: bicepReadme(model, options), description: 'how to deploy' },
      ];
    case 'terraform':
      return [
        { name: 'main.tf', content: toTerraform(), description: 'generic module' },
        { name: `${env}.tfvars`, content: toTfvars(model, options), description: 'values for this environment' },
        { name: 'design.auto.tfvars.json', content: toTerraformDesign(model), description: 'design' },
        { name: 'README.md', content: terraformReadme(model, options), description: 'how to deploy' },
      ];
    case 'terragrunt':
      return [
        { name: 'root.hcl', content: toTerragruntRoot(), description: 'shared state and provider' },
        { name: 'modules/governance/main.tf', content: toTerraform({ terragrunt: true }), description: 'generic module' },
        { name: `${terragruntLiveDir(env)}/terragrunt.hcl`, content: toTerragruntLive(model, options), description: 'values for this environment' },
        { name: `${terragruntLiveDir(env)}/design.json`, content: toTerraformDesign(model), description: 'design' },
        { name: 'README.md', content: terragruntReadme(model, options), description: 'how to deploy' },
      ];
  }
}
