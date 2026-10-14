import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import type { Catalog } from './catalog';
import { DEFAULT_INPUT, buildDesign, type DesignInput } from './engine';
import { type AlzLibrary, type IacFormat, buildIacModel, generateIacFiles, inputValue, manualPolicyCount, unsetInputs } from './iac';
import { DEFAULT_PIM } from './pim';
import { crc32, createZip } from './zip';

const catalog = catalogJson as unknown as Catalog;
const library = JSON.parse(readFileSync(new URL('../../public/alz-library.json', import.meta.url), 'utf8')) as AlzLibrary;

/** Inputs the templates fill from the platform resources they create. */
const CREATED = new Set([
  'log_analytics_workspace_id',
  'ama_user_assigned_managed_identity_id',
  'ama_vm_insights_data_collection_rule_id',
  'ama_change_tracking_data_collection_rule_id',
  'ama_mdfc_sql_data_collection_rule_id',
]);

const model = (input: Partial<DesignInput> = {}) => buildIacModel(buildDesign(catalog, { ...DEFAULT_INPUT, ...input }), catalog, library);

const everything: Partial<DesignInput> = {
  frameworks: catalog.frameworks.map((f) => f.key),
  enforcement: 'strict',
  confidential: true,
  cmk: true,
  sovereignty: true,
  local: true,
  excludeManualControls: true,
  parkingLot: true,
  parkingLotGuardrails: 'locked',
  pim: {
    ...DEFAULT_PIM,
    roles: [...DEFAULT_PIM.roles, 'alz:Network-Management'],
    eligibilities: [...DEFAULT_PIM.eligibilities, { id: 'network', label: 'Network administrators', role: 'alz:Network-Management', mg: 'connectivity' }],
  },
  overrides: {
    'landingzones/Deny-MgmtPorts-Internet': { notScopes: [{ kind: 'managementGroup', role: 'online' }] },
    'landingzones/Deny-IP-forwarding': { enforcementMode: 'DoNotEnforce' },
  },
  exemptions: [
    {
      id: 'a',
      mg: 'root',
      assignment: 'Deploy-MDFC-Config-H224',
      scope: { kind: 'managementGroup', role: 'sandbox' },
      policies: ['44433aa3-7ec2-4002-93ea-65c65ff0310a'],
      category: 'Waiver',
      reason: 'Sandbox',
      expiresOn: '2027-01-31',
    },
    {
      id: 'b',
      mg: 'landingzones',
      assignment: 'Deny-IP-forwarding',
      scope: { kind: 'subscription', id: '11111111-2222-3333-4444-555555555555' },
      policies: [],
      category: 'Mitigated',
      reason: 'NVA',
    },
    {
      id: 'c',
      mg: 'landingzones',
      assignment: 'Deny-IP-forwarding',
      scope: { kind: 'resourceGroup', id: '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-nva' },
      policies: [],
      category: 'Mitigated',
      reason: 'NVA',
    },
  ],
};

describe('buildIacModel', () => {
  it('pins the ALZ library the catalog was built from', () => {
    expect(library.ref).toBe(catalog.alz.ref);
  });

  for (const [label, input] of [
    ['default design', {}],
    ['every framework, strict', everything],
    ['single platform group, audit', { platform: 'single', enforcement: 'audit', corp: false } as Partial<DesignInput>],
  ] as const) {
    describe(label, () => {
      const m = model(input);
      const mgIds = new Set(m.managementGroups.map((g) => g.id));
      const root = m.managementGroups[0].id;
      const customDefs = new Set(m.policyDefinitions.map((d) => d.name));
      const customSets = new Set(m.policySetDefinitions.map((d) => d.name));

      it('lists parents before their children', () => {
        const seen = new Set<string>();
        for (const g of m.managementGroups) {
          if (g.parentId) expect(seen.has(g.parentId)).toBe(true);
          seen.add(g.id);
        }
      });

      it('includes every custom definition the assignments and initiatives reference', () => {
        expect(m.notes.filter((n) => n.startsWith('Not found'))).toEqual([]);
        for (const a of m.assignments) {
          expect(mgIds.has(a.managementGroupId)).toBe(true);
          const custom = /managementGroups\/([^/]+)\/providers\/Microsoft\.Authorization\/(policyDefinitions|policySetDefinitions)\/(.+)$/.exec(
            a.policyDefinitionId,
          );
          if (!custom) continue;
          expect(custom[1]).toBe(root);
          expect((custom[2] === 'policyDefinitions' ? customDefs : customSets).has(custom[3])).toBe(true);
        }
        for (const s of m.policySetDefinitions)
          for (const ref of s.properties.policyDefinitions ?? []) {
            const custom = /managementGroups\/([^/]+)\/providers\/Microsoft\.Authorization\/policyDefinitions\/(.+)$/.exec(ref.policyDefinitionId);
            if (!custom) continue;
            expect(custom[1]).toBe(root);
            expect(customDefs.has(custom[2])).toBe(true);
          }
      });

      it('leaves no ALZ placeholders or tokens in the design data', () => {
        const data = JSON.stringify([m.policyDefinitions, m.policySetDefinitions, m.assignments]);
        expect(data).not.toMatch(/placeholder|00000000-0000-0000-0000-000000000000|\$\{|\{enforcementMode\}/i);
      });

      it('gives remediating identities their roles, and only assignments with an identity get roles', () => {
        const design = buildDesign(catalog, { ...DEFAULT_INPUT, ...input });
        const remediates = new Set(
          design.mgs.flatMap((g) => g.assignments.filter((a) => a.policies.some((p) => /^(DeployIfNotExists|Modify)$/i.test(p.e))).map((a) => a.name)),
        );
        for (const a of m.assignments) {
          if (!a.identity) expect(a.roleDefinitionIds).toEqual([]);
          if (a.identity && remediates.has(a.name)) expect(a.roleDefinitionIds, a.name).not.toEqual([]);
          for (const r of a.roleDefinitionIds) expect(r).toMatch(/^[0-9a-f-]{36}$/);
        }
      });

      it('maps every per-environment parameter to a declared input or a created platform resource', () => {
        const declared = new Set(m.inputs.map((i) => i.name));
        for (const a of m.assignments)
          for (const input of Object.values(a.inputs)) expect(declared.has(input) || CREATED.has(input), input).toBe(true);
        expect(declared.has('location')).toBe(true);
        for (const created of CREATED) expect(declared.has(created)).toBe(false);
      });

      it('creates the platform resources the assignments point at, and grants their identities roles on them', () => {
        const used = new Set(m.assignments.flatMap((a) => Object.values(a.inputs)));
        expect(m.platform.logAnalyticsWorkspace).toBe(used.has('log_analytics_workspace_id') || m.platform.dataCollectionRules.length > 0);
        expect(m.platform.userAssignedIdentity).toBe(used.has('ama_user_assigned_managed_identity_id'));
        expect(m.platform.privateDnsResourceGroup).toBe(used.has('private_dns_zone_subscription_id'));
        const byName = new Map(m.assignments.map((a) => [`${a.managementGroupId}/${a.name}`, a]));
        for (const g of m.platformRoleAssignments) {
          const a = byName.get(`${g.managementGroupId}/${g.assignment}`)!;
          expect(a.identity).toBe(true);
          expect(a.roleDefinitionIds).toContain(g.roleDefinitionId);
        }
        if (m.platform.logAnalyticsWorkspace) expect(m.platformRoleAssignments.some((g) => g.scope === 'management')).toBe(true);
        if (m.platform.privateDnsResourceGroup) expect(m.platformRoleAssignments.some((g) => g.scope === 'privateDns')).toBe(true);
      });

      it('keeps assignment names within the 24-character management group limit', () => {
        for (const a of m.assignments) expect(a.name.length).toBeLessThanOrEqual(24);
      });
    });
  }

  it('names created resources <app>-<environment>-<region>-<int>-<type>, following the environment and location', () => {
    const m = model({ allowedLocations: ['westeurope'] });
    const name = (input: string, values: Record<string, string> = {}) =>
      inputValue(m.inputs.find((i) => i.name === input)!, m, { environment: 'prd', values });
    expect(name('management_resource_group_name')).toBe('management-prd-weu-01-rg');
    expect(name('log_analytics_workspace_name')).toBe('management-prd-weu-01-log');
    expect(name('ama_user_assigned_managed_identity_name')).toBe('ama-prd-weu-01-id');
    expect(name('vm_insights_data_collection_rule_name')).toBe('vminsights-prd-weu-01-dcr');
    expect(name('change_tracking_data_collection_rule_name')).toBe('changetracking-prd-weu-01-dcr');
    expect(name('defender_sql_data_collection_rule_name')).toBe('defendersql-prd-weu-01-dcr');
    expect(name('private_dns_zone_resource_group_name')).toBe('privatedns-prd-weu-01-rg');
    expect(name('resource_group_name_mdfc')).toBe('mdfcexport-prd-weu-01-rg');
    expect(name('management_resource_group_name', { location: 'eastus2' })).toBe('management-prd-eus2-01-rg');
    expect(inputValue(m.inputs.find((i) => i.name === 'log_analytics_workspace_name')!, m, { environment: 'dev', values: {} })).toBe(
      'management-dev-weu-01-log',
    );
    expect(name('management_resource_group_name', { management_resource_group_name: 'my-rg' })).toBe('my-rg');
  });

  it('creates the default private DNS zones, with regional names for the private DNS zone region', () => {
    const m = model();
    expect(m.platform.privateDnsZones).toContain('privatelink.blob.core.windows.net');
    expect(m.platform.privateDnsZones).toContain('privatelink.database.windows.net');
    expect(m.platform.privateDnsZones).toContain('privatelink.vaultcore.azure.net');
    expect(m.platform.privateDnsZones).toContain('privatelink.{regionName}.azurecontainerapps.io');
    const files = generateIacFiles('bicep', m, { environment: 'prd', values: { private_dns_zone_region: 'westeurope' } });
    const zones = JSON.parse(files.find((f) => f.name === 'lib/platform-resources.json')!.content).privateDnsZones as string[];
    expect(zones).toContain('privatelink.westeurope.azurecontainerapps.io');
    expect(zones.some((z) => z.includes('{'))).toBe(false);
    expect(new Set(zones).size).toBe(zones.length);
    expect(model({ privateDnsZones: [] }).platform.privateDnsZones).toEqual([]);
    expect(model({ privateCorp: false }).platform).toMatchObject({ privateDnsResourceGroup: false, privateDnsZones: [] });
  });

  it('uses one platform subscription for a single platform group, and places it in Platform', () => {
    const m = model({ platform: 'single' });
    const names = m.inputs.map((i) => i.name);
    expect(names).toContain('platform_subscription_id');
    expect(names).not.toContain('management_subscription_id');
    expect(names).not.toContain('private_dns_zone_subscription_id');
    expect(m.aliases).toEqual({ management_subscription_id: 'platform_subscription_id', private_dns_zone_subscription_id: 'platform_subscription_id' });
    expect(m.subscriptionPlacements).toEqual([{ managementGroupId: 'contoso-platform', input: 'platform_subscription_id' }]);
    const sub = '11111111-2222-3333-4444-555555555555';
    const options = { environment: 'prd', values: { platform_subscription_id: sub } };
    const tfvars = generateIacFiles('terraform', m, options).find((f) => f.name === 'prd.tfvars')!.content;
    expect(tfvars).toContain(`management_subscription_id = "${sub}"`);
    expect(tfvars).toContain(`private_dns_zone_subscription_id = "${sub}"`);
    const params = generateIacFiles('bicep', m, options).find((f) => f.name === 'prd.bicepparam')!.content;
    expect(params).toContain(`management_subscription_id: '${sub}' // same as platform_subscription_id`);
    expect(unsetInputs(m, options).map((i) => i.name)).not.toContain('platform_subscription_id');
  });

  it('places the management and connectivity subscriptions in their groups, unless turned off', () => {
    const m = model();
    expect(m.subscriptionPlacements).toEqual([
      { managementGroupId: 'contoso-management', input: 'management_subscription_id' },
      { managementGroupId: 'contoso-connectivity', input: 'private_dns_zone_subscription_id' },
    ]);
    const off = generateIacFiles('bicep', m, { environment: 'prd', values: {}, placeSubscriptions: false });
    expect(JSON.parse(off.find((f) => f.name === 'lib/subscription-placements.json')!.content)).toEqual([]);
  });

  it('asks for the hub virtual networks to link the private DNS zones to', () => {
    const m = model();
    const input = m.inputs.find((i) => i.name === 'private_dns_virtual_network_ids')!;
    expect(input.placeholder).toBe('');
    expect(unsetInputs(m, { environment: 'prd', values: {} }).map((i) => i.name)).toContain('private_dns_virtual_network_ids');
    expect(model({ privateDnsZones: [] }).inputs.map((i) => i.name)).not.toContain('private_dns_virtual_network_ids');
    const bicep = generateIacFiles('bicep', m, { environment: 'prd', values: {} }).find((f) => f.name === 'modules/private-dns-zones.bicep')!.content;
    expect(bicep).toContain("Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01");
    expect(bicep).toContain('registrationEnabled: false');
  });

  it('asks for no DDoS plan by default', () => {
    expect(model().inputs.map((i) => i.name)).not.toContain('ddos_protection_plan_id');
    expect(model({ ddos: true }).inputs.map((i) => i.name)).toContain('ddos_protection_plan_id');
  });

  it('creates no management resources when monitoring and Defender are off', () => {
    const m = model({ monitoring: false, defender: false });
    expect(m.platform).toMatchObject({ logAnalyticsWorkspace: false, userAssignedIdentity: false, dataCollectionRules: [] });
    expect(m.inputs.map((i) => i.name)).not.toContain('management_subscription_id');
  });

  it('builds private DNS zone IDs from the DNS subscription, resource group and region', () => {
    const dns = model().assignments.find((a) => a.name === 'Deploy-Private-DNS-Zones')!;
    expect(Object.values(dns.inputs).sort()).toEqual([
      'private_dns_zone_region',
      'private_dns_zone_resource_group_name',
      'private_dns_zone_subscription_id',
    ]);
    expect(Object.keys(dns.parameters).filter((p) => p.endsWith('PrivateDnsZoneId'))).toEqual([]);
  });

  it('words ALZ non-compliance messages for the enforcement mode', () => {
    const m = model({ enforcement: 'audit' });
    const messages = m.assignments.flatMap((a) => a.nonComplianceMessages.map((n) => [a.enforcementMode, n.message] as const));
    expect(messages.some(([mode, msg]) => mode === 'DoNotEnforce' && / should /.test(msg))).toBe(true);
    expect(messages.some(([mode, msg]) => mode === 'Default' && / must /.test(msg))).toBe(true);
  });

  it('sets the framework enforcement initiative to Deny', () => {
    const m = model({ enforcement: 'strict' });
    const set = m.policySetDefinitions.find((s) => s.name === 'Enforce-Framework-GR')!;
    expect(set.properties.policyDefinitions!.length).toBeGreaterThan(0);
    for (const ref of set.properties.policyDefinitions!) expect(ref.parameters).toEqual({ effect: { value: 'Deny' } });
  });

  it('sets every Defender plan explicitly over the ALZ Disabled defaults', () => {
    const a = model({ defenderPlans: ['Servers', 'Cspm'] }).assignments.find((x) => x.name === 'Deploy-MDFC-Config-H224')!;
    expect(a.parameters.enableAscForServers).toEqual({ value: 'DeployIfNotExists' });
    expect(a.parameters.enableAscForCspm).toEqual({ value: 'DeployIfNotExists' });
    expect(a.parameters.enableAscForStorage).toEqual({ value: 'Disabled' });
    expect(a.parameters.enableAscForAI).toEqual({ value: 'Disabled' });
  });

  it('reports inputs still at their placeholder', () => {
    const m = model();
    const unset = unsetInputs(m, { environment: 'prod', values: {} }).map((i) => i.name);
    expect(unset).toContain('management_subscription_id');
    expect(unset).not.toContain('location');
    expect(unset).not.toContain('management_resource_group_name');
    const filled = unsetInputs(m, { environment: 'prod', values: { management_subscription_id: '11111111-2222-3333-4444-555555555555' } }).map(
      (i) => i.name,
    );
    expect(filled).not.toContain('management_subscription_id');
  });
});

describe('Azure Government export', () => {
  const m = model({ cloud: 'AzureUSGovernment', allowedLocations: ['usgovvirginia'] });

  it('targets the usgovernment cloud and uses Government private DNS zone names', () => {
    expect(m.cloud).toBe('usgovernment');
    expect(m.platform.privateDnsZones).toContain('privatelink.blob.core.usgovcloudapi.net');
    expect(m.platform.privateDnsZones).toContain('privatelink.vaultcore.usgovcloudapi.net');
    expect(m.platform.privateDnsZones).toContain('privatelink.database.usgovcloudapi.net');
    expect(m.platform.privateDnsZones.some((z) => /\.windows\.net$|\.azure\.com$|\.azure\.net$/.test(z))).toBe(false);
    const dns = m.assignments.find((a) => a.name === 'Deploy-Private-DNS-Zones')!;
    const names = dns.parameters.dnsZoneNames.value as Record<string, string>;
    expect(names.azureStorageBlobPrivateDnsZoneId).toBe('privatelink.blob.core.usgovcloudapi.net');
    expect(names.azureKeyVaultPrivateDnsZoneId).toBe('privatelink.vaultcore.usgovcloudapi.net');
    const files = generateIacFiles('terraform', m, { environment: 'prd', values: {} });
    expect(JSON.parse(files.find((f) => f.name === 'design.auto.tfvars.json')!.content).cloud_environment).toBe('usgovernment');
  });

  it('leaves Government-missing built-ins out of the ALZ initiatives', () => {
    for (const set of m.policySetDefinitions)
      for (const ref of set.properties.policyDefinitions ?? []) {
        const id = ref.policyDefinitionId.split('/').pop()!;
        if (ref.policyDefinitionId.startsWith('/providers/Microsoft.Authorization/')) expect(catalog.policies[id]?.ng, `${set.name} ${id}`).toBeFalsy();
      }
    expect(m.notes.some((n) => n.startsWith('Azure Government:'))).toBe(true);
  });

  it('creates no empty initiatives, and no messages for left-out policies', () => {
    for (const set of m.policySetDefinitions) expect(set.properties.policyDefinitions!.length, set.name).toBeGreaterThan(0);
    for (const a of m.assignments) {
      const set = m.policySetDefinitions.find((x) => a.policyDefinitionId.endsWith(`/${x.name}`));
      if (!set) continue;
      const refs = new Set(set.properties.policyDefinitions!.map((r) => r.policyDefinitionReferenceId));
      for (const msg of a.nonComplianceMessages) if (msg.policyDefinitionReferenceId) expect(refs.has(msg.policyDefinitionReferenceId), a.name).toBe(true);
    }
  });

  it('names resources with Government region codes', () => {
    const rg = m.inputs.find((i) => i.name === 'management_resource_group_name')!;
    expect(inputValue(rg, m, { environment: 'prd', values: {} })).toBe('management-prd-usgv-01-rg');
  });
});

describe('overrides and exemptions in the export', () => {
  const sub = '11111111-2222-3333-4444-555555555555';
  const m = model({
    overrides: {
      'landingzones/Deny-MgmtPorts-Internet': {
        notScopes: [
          { kind: 'managementGroup', role: 'online' },
          { kind: 'subscription', id: sub },
        ],
      },
      'root/Deploy-AzActivity-Log': { parameters: { logAnalytics: '/subscriptions/x/resourceGroups/y/providers/Microsoft.OperationalInsights/workspaces/z' } },
    },
    exemptions: [
      {
        id: 'a',
        mg: 'root',
        assignment: 'Deploy-MDFC-Config-H224',
        scope: { kind: 'managementGroup', role: 'sandbox' },
        policies: ['44433aa3-7ec2-4002-93ea-65c65ff0310a'],
        category: 'Waiver',
        reason: 'Sandbox has no open-source databases',
        expiresOn: '2027-01-31',
      },
      {
        id: 'b',
        mg: 'landingzones',
        assignment: 'Deny-IP-forwarding',
        scope: { kind: 'resourceGroup', id: `/subscriptions/${sub}/resourceGroups/rg-nva` },
        policies: [],
        category: 'Mitigated',
        reason: 'NVA subnet',
      },
    ],
  });

  it('resolves excluded scopes to resource IDs', () => {
    const a = m.assignments.find((x) => x.name === 'Deny-MgmtPorts-Internet' && x.managementGroupId === 'contoso-landingzones')!;
    expect(a.notScopes).toEqual(['/providers/Microsoft.Management/managementGroups/contoso-online', `/subscriptions/${sub}`]);
  });

  it('lets parameter overrides replace ALZ inputs', () => {
    const a = m.assignments.find((x) => x.name === 'Deploy-AzActivity-Log')!;
    expect(a.inputs.logAnalytics).toBeUndefined();
    expect(a.parameters.logAnalytics.value).toContain('/workspaces/z');
  });

  it('exports exemptions with reference IDs, scope and expiry', () => {
    expect(m.exemptions).toEqual([
      expect.objectContaining({
        managementGroupId: 'contoso',
        assignment: 'Deploy-MDFC-Config-H224',
        scope: { kind: 'managementGroup', managementGroupId: 'contoso-sandbox' },
        policyDefinitionReferenceIds: ['defenderForOssDb'],
        category: 'Waiver',
        expiresOn: '2027-01-31T00:00:00Z',
      }),
      expect.objectContaining({
        assignment: 'Deny-IP-forwarding',
        scope: { kind: 'resourceGroup', subscriptionId: sub, resourceGroupName: 'rg-nva' },
        policyDefinitionReferenceIds: [],
        expiresOn: null,
      }),
    ]);
  });
});

describe('parking lot in the export', () => {
  it('sets the tenant default management group only when there is a parking lot', () => {
    expect(model({ parkingLot: false }).hierarchySettings).toBeNull();
    expect(model().hierarchySettings).toEqual({ defaultManagementGroupId: 'contoso-parkinglot', requireAuthorizationForGroupCreation: true });
    const m = model({ parkingLot: true, requireManagementGroupAuthorization: false });
    expect(m.hierarchySettings).toEqual({ defaultManagementGroupId: 'contoso-parkinglot', requireAuthorizationForGroupCreation: false });
    expect(m.managementGroups.find((g) => g.id === 'contoso-parkinglot')!.parentId).toBe('contoso');
    const files = generateIacFiles('terraform', m, { environment: 'prd', values: {} });
    expect(JSON.parse(files.find((f) => f.name === 'design.auto.tfvars.json')!.content).hierarchy_settings).toEqual({
      default_management_group_id: 'contoso-parkinglot',
      require_authorization_for_group_creation: false,
    });
    expect(files.find((f) => f.name === 'README.md')!.content).toContain("sets the tenant's default management group to `contoso-parkinglot`");
  });
});

describe('locked parking lot in the export', () => {
  it('creates a mode All policy that denies every type but the security baseline, assigned at the parking lot', () => {
    const m = model();
    const def = m.policyDefinitions.find((d) => d.name === 'Deny-ParkingLot-Resources')!;
    expect(def.properties.mode).toBe('All');
    expect(def.properties.policyRule).toEqual({
      if: { field: 'type', notIn: "[parameters('allowedResourceTypes')]" },
      then: { effect: "[parameters('effect')]" },
    });
    expect((def.properties.parameters as Record<string, { defaultValue: unknown }>).allowedResourceTypes.defaultValue).toContain('Microsoft.Security/pricings');
    const a = m.assignments.find((x) => x.name === 'Deny-Parking-Resources')!;
    expect(a.managementGroupId).toBe('contoso-parkinglot');
    expect(a.policyDefinitionId).toBe('/providers/Microsoft.Management/managementGroups/contoso/providers/Microsoft.Authorization/policyDefinitions/Deny-ParkingLot-Resources');
    expect(generateIacFiles('bicep', m, { environment: 'prd', values: {} }).find((f) => f.name === 'README.md')!.content).toContain('The parking lot is locked');
  });
});

describe('custom roles in the export', () => {
  it('defines them at the top management group with unique names and their permissions', () => {
    const m = model();
    expect(m.roleDefinitions.map((r) => r.roleName)).toContain('Network-Management (contoso)');
    for (const r of m.roleDefinitions) {
      expect(r.permissions.length).toBeGreaterThan(0);
      expect(r.permissions[0].actions.length + r.permissions[0].dataActions.length).toBeGreaterThan(0);
    }
    const files = generateIacFiles('terraform', m, { environment: 'prd', values: {} });
    const data = JSON.parse(files.find((f) => f.name === 'design.auto.tfvars.json')!.content);
    expect(data.role_definitions.length).toBe(5);
    expect(model({ alzCustomRoles: false }).roleDefinitions).toEqual([]);
  });

  it('uses the custom role IDs for PIM', () => {
    const m = model({
      pim: {
        enabled: true,
        profile: 'auto',
        roles: ['alz:Network-Management'],
        eligibilities: [{ id: 'n', label: 'Network admins', role: 'alz:Network-Management', mg: 'connectivity' }],
      },
    });
    const id = m.roleDefinitions.find((r) => r.roleName.startsWith('Network-Management'))!.name;
    expect(m.pim!.roles).toEqual([{ name: 'Network-Management', roleDefinitionId: id, requireApproval: false }]);
    expect(m.pim!.eligibilities[0]).toMatchObject({ roleDefinitionId: id, managementGroupId: 'contoso-connectivity' });
  });
});

describe('PIM in the export', () => {
  const m = model({ frameworks: ['fedramp-high'] });

  it('sets role settings at every management group and asks for the group object IDs', () => {
    expect(m.pim!.managementGroupIds).toEqual(m.managementGroups.map((g) => g.id));
    expect(m.pim!.roles.map((r) => r.name)).toEqual(['Owner', 'User Access Administrator', 'Role Based Access Control Administrator', 'Contributor']);
    expect(m.pim!.eligibilities).toEqual([
      expect.objectContaining({ name: 'Platform owners', roleName: 'Owner', managementGroupId: 'contoso', input: 'pim_group_platform_owners' }),
      expect.objectContaining({ name: 'Access administrators', input: 'pim_group_access_administrators' }),
      expect.objectContaining({ name: 'Landing zone contributors', managementGroupId: 'contoso-landingzones' }),
    ]);
    const names = m.inputs.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['pim_approver_group_id', 'pim_group_platform_owners']));
    expect(unsetInputs(m, { environment: 'prd', values: {} }).map((i) => i.name)).toContain('pim_group_platform_owners');
  });

  it('writes the PIM policy script for Bicep, with the approver from the values', () => {
    const files = generateIacFiles('bicep', m, { environment: 'prd', values: { pim_approver_group_id: 'abc' } });
    const script = files.find((f) => f.name === 'scripts/set-pim-policies.sh')!.content;
    expect(script).toContain('APPROVER_GROUP_ID="${PIM_APPROVER_GROUP_ID:-abc}"');
    expect(script).toContain('--uri-parameters "\\$filter=roleDefinitionId eq');
    expect(script.match(/^apply /gm)!.length).toBe(m.pim!.managementGroupIds.length * 4);
    expect(files.some((f) => f.name === 'modules/pim-eligibility.bicep')).toBe(true);
    expect(model({ pim: { enabled: false, profile: 'auto', roles: [], eligibilities: [] } }).pim).toBeNull();
  });
});

describe('excluding manual-only controls', () => {
  const m = model({ frameworks: ['nist-800-53-r5', 'mcsb'] });
  const nist = () => m.assignments.find((a) => a.name === 'Audit-NIST-800-53-R5')!;

  it('records the manual-attestation policies of initiative assignments', () => {
    const manual = catalog.frameworks.find((f) => f.key === 'nist-800-53-r5')!.refs.filter((r) => r.e === 'Manual');
    expect(nist().manualReferenceIds.length).toBe(manual.length);
    expect(nist().manualReferenceIds).toContain(manual[0].r);
    expect(manualPolicyCount(m)).toEqual({ policies: manual.length, assignments: 1, capped: [] });
  });

  it('turns them off with effect overrides of up to 50 reference IDs each, only when asked', () => {
    const files = (excludeManualControls: boolean) =>
      generateIacFiles('bicep', model({ frameworks: ['nist-800-53-r5', 'mcsb'], excludeManualControls }), { environment: 'prd', values: {} });
    const assignment = (excludeManualControls: boolean) =>
      JSON.parse(files(excludeManualControls).find((f) => f.name === 'lib/policy-assignments.json')!.content).find(
        (a: { name: string }) => a.name === 'Audit-NIST-800-53-R5',
      );
    expect(assignment(false).overrides).toEqual([]);
    const overrides = assignment(true).overrides as { value: string; selectors: { kind: string; in: string[] }[] }[];
    expect(overrides.length).toBe(Math.ceil(nist().manualReferenceIds.length / 50));
    expect(overrides.length).toBeLessThanOrEqual(10);
    for (const o of overrides) {
      expect(o.value).toBe('Disabled');
      expect(o.selectors[0].kind).toBe('policyDefinitionReferenceId');
      expect(o.selectors[0].in.length).toBeLessThanOrEqual(50);
    }
    expect(overrides.flatMap((o) => o.selectors[0].in).sort()).toEqual([...nist().manualReferenceIds].sort());
    expect(assignment(false).manualReferenceIds).toBeUndefined();

    const excluding = model({ frameworks: ['nist-800-53-r5', 'mcsb'], excludeManualControls: true });
    const tf = JSON.parse(generateIacFiles('terraform', excluding, { environment: 'prd', values: {} }).find((f) => f.name === 'design.auto.tfvars.json')!.content);
    const tfNist = tf.policy_assignments.find((a: { name: string }) => a.name === 'Audit-NIST-800-53-R5');
    expect(tfNist.overrides.flatMap((o: { reference_ids: string[] }) => o.reference_ids).length).toBe(nist().manualReferenceIds.length);
    expect(generateIacFiles('terraform', excluding, { environment: 'prd', values: {} }).find((f) => f.name === 'README.md')!.content).toContain(
      'Manual-only controls excluded',
    );
  });

  it('fits every framework within the 500 overrides an assignment allows', () => {
    const all = model({ frameworks: catalog.frameworks.map((f) => f.key) });
    expect(manualPolicyCount(all).capped).toEqual([]);
  });
});

describe('generateIacFiles', () => {
  const m = model(everything);
  const options = { environment: 'prod', values: {} };

  it('gives each format its template, values and design', () => {
    const names = (f: IacFormat) => generateIacFiles(f, m, options).map((x) => x.name);
    expect(names('bicep')).toEqual(expect.arrayContaining(['main.bicep', 'prod.bicepparam', 'lib/policy-assignments.json']));
    expect(names('terraform')).toEqual(expect.arrayContaining(['main.tf', 'prod.tfvars', 'design.auto.tfvars.json']));
    expect(names('terragrunt')).toEqual(
      expect.arrayContaining(['root.hcl', 'modules/governance/main.tf', 'live/prod/governance/terragrunt.hcl', 'live/prod/governance/design.json']),
    );
  });

  it('keeps Bicep design files within loadJsonContent’s size limit', () => {
    for (const f of generateIacFiles('bicep', m, options).filter((x) => x.name.startsWith('lib/')))
      expect(f.content.length).toBeLessThan(1_048_576);
  });

  // IAC_OUT_DIR=<dir> npm test writes sample exports, for az bicep build / terraform validate.
  const out = process.env.IAC_OUT_DIR;
  it.skipIf(!out)('writes sample files', () => {
    for (const format of ['bicep', 'terraform', 'terragrunt'] as const)
      for (const f of generateIacFiles(format, m, options)) {
        const path = join(out!, format, f.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content);
      }
  });
});

describe('Azure limits', () => {
  it('keeps display names within 128 characters and descriptions within 512', () => {
    const m = model(everything);
    for (const x of [...m.assignments, ...m.policySetDefinitions.map((s) => ({ name: s.name, ...s.properties }))]) {
      expect((x.displayName ?? '').length, x.name).toBeLessThanOrEqual(128);
      expect((x.description ?? '').length, x.name).toBeLessThanOrEqual(512);
    }
  });
});

describe('createZip', () => {
  it('zips files with their folders', () => {
    const zip = createZip([
      { name: 'a/b.txt', content: 'hello' },
      { name: 'c.txt', content: 'é' },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
