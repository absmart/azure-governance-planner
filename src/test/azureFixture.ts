// A synthetic Resource Graph export with fake IDs, for the import and compare
// tests. Never put real tenant data here.

import catalogJson from '../data/catalog.json';
import type { Catalog } from '../lib/catalog';

const catalog = catalogJson as unknown as Catalog;
export const nist = catalog.frameworks.find((f) => f.key === 'nist-800-53-r5')!;
export const tenant = '00000000-1111-2222-3333-444444444444';
export const sub = '55555555-6666-7777-8888-999999999999';
export const mg = (name: string) => `/providers/Microsoft.Management/managementGroups/${name}`;
export const builtIn = (guid: string) => `/providers/Microsoft.Authorization/policyDefinitions/${guid}`;

// Two Deny-capable built-ins from the NIST initiative, for a custom initiative.
export const [denyA, denyB] = nist.refs.map((r) => r.p).filter((p, i, all) => catalog.policies[p]?.a.includes('Deny') && all.indexOf(p) === i);

/** A Resource Graph export shaped like the import commands' output (fake IDs). */
export function fixture(): string {
  const page1 = {
    totalRecords: 6,
    count: 6,
    data: [
      { id: mg('contoso'), name: 'contoso', type: 'microsoft.management/managementgroups', properties: { displayName: 'Contoso', details: { parent: { id: mg(tenant) } } } },
      {
        id: mg('contoso-landingzones'),
        name: 'contoso-landingzones',
        type: 'microsoft.management/managementgroups',
        properties: { displayName: 'Landing zones', details: { parent: { id: mg('contoso') } } },
      },
      {
        id: `${mg('contoso')}/providers/Microsoft.Authorization/policySetDefinitions/Enforce-Guardrails-Custom_20250101`,
        name: 'Enforce-Guardrails-Custom_20250101',
        type: 'microsoft.authorization/policysetdefinitions',
        properties: {
          displayName: 'Custom guardrails',
          policyType: 'Custom',
          parameters: { effect: { type: 'String', defaultValue: 'Audit' } },
          policyDefinitions: [
            { policyDefinitionReferenceId: 'refA', policyDefinitionId: builtIn(denyA), parameters: { effect: { value: "[parameters('effect')]" } } },
            { policyDefinitionReferenceId: 'refB', policyDefinitionId: builtIn(denyB), parameters: { effect: { value: 'Deny' } } },
            { policyDefinitionReferenceId: 'refC', policyDefinitionId: `${mg('contoso')}/providers/Microsoft.Authorization/policyDefinitions/My-Custom-Policy` },
          ],
        },
      },
      {
        id: `${mg('contoso')}/providers/Microsoft.Authorization/policyDefinitions/My-Custom-Policy`,
        name: 'My-Custom-Policy',
        type: 'microsoft.authorization/policydefinitions',
        properties: {
          displayName: 'My custom policy',
          policyType: 'Custom',
          parameters: { effect: { type: 'String', defaultValue: 'AuditIfNotExists' } },
          policyRule: { if: {}, then: { effect: "[parameters('effect')]" } },
        },
      },
      {
        id: `${mg('contoso')}/providers/Microsoft.Authorization/policyAssignments/Audit-NIST`,
        name: 'Audit-NIST',
        type: 'microsoft.authorization/policyassignments',
        properties: { displayName: 'NIST', policyDefinitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${nist.id}`, enforcementMode: 'Default' },
      },
      {
        id: `${mg('contoso-landingzones')}/providers/Microsoft.Authorization/policyAssignments/Enforce-GR-Custom`,
        name: 'Enforce-GR-Custom',
        type: 'microsoft.authorization/policyassignments',
        properties: {
          displayName: 'Custom guardrails',
          policyDefinitionId: `${mg('contoso')}/providers/Microsoft.Authorization/policySetDefinitions/Enforce-Guardrails-Custom_20250101`,
          enforcementMode: 'Default',
          parameters: { effect: { value: 'Deny' } },
          overrides: [{ kind: 'policyEffect', value: 'Disabled', selectors: [{ kind: 'policyDefinitionReferenceId', in: ['refC'] }] }],
        },
      },
    ],
  };
  const page2 = {
    totalRecords: 3,
    count: 3,
    data: [
      {
        id: `/subscriptions/${sub}/providers/Microsoft.Authorization/policyAssignments/Allowed-Locations`,
        name: 'Allowed-Locations',
        type: 'microsoft.authorization/policyassignments',
        properties: {
          displayName: 'Allowed locations',
          policyDefinitionId: builtIn('e56962a6-4747-49cd-b67b-bf8b01975c4c'),
          enforcementMode: 'DoNotEnforce',
          parameters: { listOfAllowedLocations: { value: ['eastus2'] } },
        },
      },
      {
        id: `${mg(tenant)}/providers/Microsoft.Authorization/policyAssignments/sys.mfa-write`,
        name: 'sys.mfa-write',
        type: 'microsoft.authorization/policyassignments',
        properties: { assignmentType: 'SystemHidden', policyDefinitionId: builtIn('54f51f64-eaa5-44cf-8674-830bcfd14d21'), enforcementMode: 'Default' },
      },
      {
        id: `/subscriptions/${sub}/providers/Microsoft.Authorization/policyExemptions/legacy`,
        name: 'legacy',
        type: 'microsoft.authorization/policyexemptions',
        properties: {
          displayName: 'Legacy subscription',
          exemptionCategory: 'Waiver',
          policyAssignmentId: `${mg('contoso-landingzones')}/providers/Microsoft.Authorization/policyAssignments/Enforce-GR-Custom`,
          policyDefinitionReferenceIds: ['refA'],
          expiresOn: '2027-03-31T00:00:00Z',
        },
      },
    ],
  };
  // As the commands write it: pages one after another, with az CLI noise in between.
  return `${JSON.stringify(page1, null, 2)}\nWARNING: some az CLI message\n${JSON.stringify(page2)}\n`;
}

/** Query 3's output: resources per policy definition and compliance state (fake counts). */
export function complianceFixture(): string {
  const row = (definitionId: string, compliant: number, nonCompliant: number, exempt = 0) => ({
    id: `policystates:${definitionId.toLowerCase()}`,
    name: definitionId.split('/').pop()!.toLowerCase(),
    type: 'microsoft.policyinsights/policystatesummary',
    properties: { policyDefinitionId: definitionId.toLowerCase(), compliant, nonCompliant, exempt },
  });
  return JSON.stringify({
    totalRecords: 3,
    count: 3,
    data: [
      row(builtIn(denyA), 10, 3, 1),
      row(builtIn(denyB), 5, 0),
      row(`${mg('contoso')}/providers/Microsoft.Authorization/policyDefinitions/My-Custom-Policy`, 0, 2),
    ],
  });
}
