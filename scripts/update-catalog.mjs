// Refresh src/data/catalog.json, the snapshot of Azure Policy and framework
// data the app plans with:  npm run update-catalog
//
// Sources (all public, no Azure login needed):
// - AzAdvertizer CSV exports: policy names, categories, effects and the policies
//   in every built-in and ALZ initiative.  https://www.azadvertizer.net
// - Azure/azure-policy: the built-in regulatory compliance initiatives, for the
//   control (group) each policy is mapped to.
// - Azure/Azure-Landing-Zones-Library: the ALZ management group architecture,
//   archetypes and the policy assignments each archetype makes.
// - usnistgov/oscal-content: NIST SP 800-53 Rev. 5 control titles and the
//   Low/Moderate/High/Privacy baselines (SP 800-53B).
//
// The hosted app is static, so the data is committed with the source. The ALZ
// library's definitions and assignment parameters, which only the IaC export
// needs, go to public/alz-library.json so the app loads them on demand, and
// every built-in policy and initiative (for custom assignments) to
// public/policy-index.json and public/initiative-index.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../src/data/catalog.json', import.meta.url));
const libraryOut = fileURLToPath(new URL('../public/alz-library.json', import.meta.url));
const indexOut = fileURLToPath(new URL('../public/policy-index.json', import.meta.url));
const initiativeIndexOut = fileURLToPath(new URL('../public/initiative-index.json', import.meta.url));

const AZADVERTIZER = 'https://www.azadvertizer.net';
const POLICY_REPO = 'https://raw.githubusercontent.com/Azure/azure-policy/master/built-in-policies/policySetDefinitions';
/** ALZ library release the design and the exported definitions are pinned to. */
const ALZ_REF = 'platform/alz/2026.10.0';
const ALZ_LIB = `https://raw.githubusercontent.com/Azure/Azure-Landing-Zones-Library/refs/tags/${ALZ_REF}/platform/alz`;
const ALZ_CONTENTS = 'https://api.github.com/repos/Azure/Azure-Landing-Zones-Library/contents/platform/alz';
const OSCAL = 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json';

/**
 * The frameworks offered in the app. `file` is the initiative's source in
 * Azure/azure-policy; `controlPrefix` is stripped from group names to get the
 * framework's own control IDs.
 */
const FRAMEWORKS = [
  { key: 'nist-800-53-r5', short: 'NIST 800-53 R5', group: 'US government', file: 'Regulatory Compliance/NIST_SP_800-53_R5.json', controlPrefix: 'NIST_SP_800-53_R5_', nist: true },
  { key: 'fedramp-high', short: 'FedRAMP High', group: 'US government', file: 'Regulatory Compliance/FedRAMP_H_audit.json' },
  { key: 'fedramp-moderate', short: 'FedRAMP Moderate', group: 'US government', file: 'Regulatory Compliance/FedRAMP_M_audit.json' },
  { key: 'nist-800-171-r2', short: 'NIST 800-171 R2', group: 'US government', file: 'Regulatory Compliance/NIST_SP_800-171_R2.json', controlPrefix: 'NIST_SP_800-171_R2_' },
  { key: 'cmmc-2-l2', short: 'CMMC 2.0 L2', group: 'US government', file: 'Regulatory Compliance/CMMC_2_0_L2.json' },
  { key: 'cjis', short: 'CJIS', group: 'US government', file: 'Regulatory Compliance/FBI_Criminal_Justice_Information_Services_v5.9.5.json' },
  { key: 'nist-csf-2', short: 'NIST CSF 2.0', group: 'Industry', file: 'Regulatory Compliance/NIST_CSF_v2.0.json' },
  { key: 'mcsb', short: 'MCSB', group: 'Microsoft & CIS', file: 'Security Center/AzureSecurityCenter.json' },
  { key: 'cis-azure-2', short: 'CIS Azure 2.0', group: 'Microsoft & CIS', file: 'Regulatory Compliance/CISv2_0_0.json' },
  { key: 'cis-azure-3', short: 'CIS Azure 3.0', group: 'Microsoft & CIS', file: 'Regulatory Compliance/CIS_Azure_Foundations_v3.0.0.json' },
  { key: 'iso-27001-2022', short: 'ISO 27001:2022', group: 'Industry', file: 'Regulatory Compliance/ISO_IEC_27001_2022.json' },
  { key: 'soc2', short: 'SOC 2', group: 'Industry', file: 'Regulatory Compliance/SOC_2.json' },
  { key: 'pci-dss-4', short: 'PCI DSS 4.0.1', group: 'Industry', file: 'Regulatory Compliance/PCI_DSS_v4.0.1.json' },
  { key: 'hipaa-hitrust', short: 'HIPAA/HITRUST', group: 'Industry', file: 'Regulatory Compliance/HIPAA_HITRUST_audit.json' },
  { key: 'gdpr', short: 'GDPR', group: 'EU', file: 'Regulatory Compliance/EU_GDPR_2016_679.json' },
  { key: 'nis2', short: 'NIS2', group: 'EU', file: 'Regulatory Compliance/EU_2555_(NIS2)_2022.json' },
];

const ALZ_ARCHETYPES = [
  'root', 'platform', 'connectivity', 'identity', 'management', 'security',
  'landing_zones', 'corp', 'online', 'local', 'sandbox', 'decommissioned',
];

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': 'azure-governance-planner catalog script' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return as === 'json' ? res.json() : res.text();
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** RFC 4180 CSV parser (quoted fields may contain commas, quotes and newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** "audit; Audit; disabled; Disabled" -> ["Audit", "Disabled"] */
function effects(list) {
  const seen = new Map();
  for (const raw of list.split(/[;,]/)) {
    const e = raw.trim();
    if (!e) continue;
    const k = e.toLowerCase();
    if (!seen.has(k) || /^[A-Z]/.test(e)) seen.set(k, e[0].toUpperCase() + e.slice(1));
  }
  return [...seen.values()];
}

const guidOf = (definitionId) => definitionId.split('/').pop();

/** "Monitoring Contributor (749f88d5-...); Log Analytics Contributor (92aaf0da-...)" -> role GUIDs */
const roleIds = (list) => [...(list ?? '').matchAll(/\(([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase());

/** "ac-2.1" -> "AC-2(1)" */
const oscalToControl = (id) => id.toUpperCase().replace(/\.(\d+)$/, '($1)');

console.log('Downloading AzAdvertizer exports…');
const [policyRows, initiativeRows] = await Promise.all([
  get(`${AZADVERTIZER}/azpolicyadvertizer-comma.csv`, 'text').then(parseCsv),
  get(`${AZADVERTIZER}/azpolicyinitiativesadvertizer-comma.csv`, 'text').then(parseCsv),
]);

const policyIndex = new Map(policyRows.map((p) => [p.policyId, p]));
const initiativeMembers = new Map();
const initiativeInfo = new Map();
for (const r of initiativeRows) {
  if (!initiativeMembers.has(r.initiativeId)) {
    initiativeMembers.set(r.initiativeId, []);
    initiativeInfo.set(r.initiativeId, r);
  }
  initiativeMembers.get(r.initiativeId).push(r);
}

/** A policy's catalog entry from its AzAdvertizer row. */
function policyInfo(p, fallback, descriptionLength = 400) {
  return {
    n: p.policyName,
    c: p.policyCategory,
    e: p.policyEffect || fallback?.initiativePolicyEffectDefault || '',
    a: effects(p.policyEffectAllowedValues || ''),
    d: p.policyDescription.replace(/;\s/g, ', ').slice(0, descriptionLength),
    v: p.policyVersion,
    t: p.policyType === 'BuiltIn' ? 'BuiltIn' : 'ALZ',
    ...(roleIds(p.policyRolesUsed).length ? { r: roleIds(p.policyRolesUsed) } : {}),
    // Built-ins missing from Azure Government. Undated rows (the oldest built-ins) list
    // only AzureCloud even when they are in Government, so only dated rows count.
    ...(p.policyType === 'BuiltIn' && p.dateAdded && !/AzureUSGovernment/.test(p.cloudEnvs ?? '') ? { ng: true } : {}),
    ...(p.policyPreview ? { pv: true } : {}),
    ...(p.policyDeprecated ? { dp: true } : {}),
  };
}

/** Policies referenced anywhere in the catalog, keyed by GUID (or ALZ name). */
const policies = {};
function usePolicy(id, fallback) {
  if (policies[id]) return;
  const p = policyIndex.get(id);
  if (p) {
    policies[id] = policyInfo(p, fallback);
  } else if (fallback) {
    policies[id] = {
      n: fallback.initiativePolicyName,
      c: fallback.initiativePolicyCategory,
      e: fallback.initiativePolicyEffectDefault,
      a: effects(fallback.initiativePolicyEffectAllowed || ''),
      d: fallback.initiativePolicyDescription.slice(0, 400),
      v: fallback.initiativePolicyVersion,
      t: fallback.initiativePolicyType === 'BuiltIn' ? 'BuiltIn' : 'ALZ',
    };
  } else {
    console.warn(`  unknown policy ${id}`);
  }
}

// --- Frameworks --------------------------------------------------------------

console.log('Downloading framework initiatives…');
const frameworks = [];
for (const f of FRAMEWORKS) {
  const def = await get(`${POLICY_REPO}/${encodePath(f.file)}`);
  const id = def.name;
  const members = initiativeMembers.get(id) ?? [];
  const memberByRef = new Map(members.map((m) => [m.initiativePolicyReferenceId, m]));
  const info = initiativeInfo.get(id);
  const groupNames = new Set();
  for (const ref of def.properties.policyDefinitions) for (const g of ref.groupNames ?? []) groupNames.add(g);
  for (const g of def.properties.policyDefinitionGroups ?? []) groupNames.add(g.name);
  const prefix = f.controlPrefix ?? commonPrefix([...groupNames]);
  const control = (g) => (g.startsWith(prefix) ? g.slice(prefix.length) : g).replace(/_/g, '-');

  const refs = def.properties.policyDefinitions.map((ref) => {
    const pid = guidOf(ref.policyDefinitionId);
    const member = memberByRef.get(ref.policyDefinitionReferenceId);
    usePolicy(pid, member);
    // The effect the initiative assigns by default (often parameterised to Audit).
    const effect = resolveEffect(def, ref) || member?.initiativePolicyEffectDefault || policies[pid]?.e || '';
    return { p: pid, e: effect, g: (ref.groupNames ?? []).map(control), r: ref.policyDefinitionReferenceId };
  });

  frameworks.push({
    key: f.key,
    short: f.short,
    group: f.group,
    id,
    name: def.properties.displayName,
    description: def.properties.description,
    version: info?.initiativeVersion || def.properties.metadata?.version,
    usGov: info ? info.initiativeAzUSGov === 'true' : undefined,
    nist: !!f.nist,
    controls: [...groupNames].map(control).sort(compareControls),
    refs,
    source: `https://github.com/Azure/azure-policy/blob/master/built-in-policies/policySetDefinitions/${encodePath(f.file)}`,
  });
  console.log(`  ${f.short}: ${refs.length} policies, ${groupNames.size} controls`);
}

function commonPrefix(names) {
  if (!names.length) return '';
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  // Only strip whole tokens.
  const cut = Math.max(p.lastIndexOf('_'), p.lastIndexOf(' '));
  return cut >= 0 ? p.slice(0, cut + 1) : '';
}

/**
 * The effect an initiative reference runs with: a literal, or the initiative
 * parameter it is wired to, taken from the assignment's values when given and
 * the parameter's default otherwise.
 */
function resolveEffect(def, ref, assigned = {}) {
  const key = Object.keys(ref.parameters ?? {}).find((k) => k.toLowerCase() === 'effect');
  const raw = key ? ref.parameters[key].value : undefined;
  if (typeof raw !== 'string') return null;
  const m = /^\[parameters\('(.+)'\)\]$/.exec(raw);
  const value = m ? (assigned[m[1]]?.value ?? def.properties.parameters?.[m[1]]?.defaultValue) : raw;
  // Definitions mix 'deny' and 'Deny'.
  return typeof value === 'string' && value ? value[0].toUpperCase() + value.slice(1) : null;
}

function compareControls(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

// --- NIST SP 800-53 Rev. 5 ---------------------------------------------------

console.log('Downloading NIST SP 800-53 Rev. 5 catalog and baselines…');
const oscal = await get(`${OSCAL}/NIST_SP-800-53_rev5_catalog-min.json`);
const families = {};
const nistControls = {};
for (const group of oscal.catalog.groups) {
  families[group.id.toUpperCase()] = group.title;
  const walk = (controls) => {
    for (const c of controls ?? []) {
      const withdrawn = c.props?.some((p) => p.name === 'status' && p.value === 'withdrawn');
      if (!withdrawn) nistControls[oscalToControl(c.id)] = { t: c.title, b: [] };
      walk(c.controls);
    }
  };
  walk(group.controls);
}
for (const [baseline, code] of [['LOW', 'L'], ['MODERATE', 'M'], ['HIGH', 'H'], ['PRIVACY', 'P']]) {
  const profile = await get(`${OSCAL}/NIST_SP-800-53_rev5_${baseline}-baseline_profile-min.json`);
  const ids = profile.profile.imports.flatMap((i) => i['include-controls']?.flatMap((ic) => ic['with-ids']) ?? []);
  for (const id of ids) nistControls[oscalToControl(id)]?.b.push(code);
  console.log(`  ${baseline}: ${ids.length} controls`);
}

// --- Azure Landing Zones -----------------------------------------------------

console.log('Downloading ALZ library…');
const architecture = await get(`${ALZ_LIB}/architecture_definitions/alz.alz_architecture_definition.json`);
const archetypes = {};
for (const a of ALZ_ARCHETYPES) {
  const def = await get(`${ALZ_LIB}/archetype_definitions/${a}.alz_archetype_definition.json`);
  archetypes[a] = def.policy_assignments;
}
const assignmentNames = [...new Set(Object.values(archetypes).flat())].sort();
const alzInitiatives = [...initiativeInfo.values()].filter((i) => i.initiativeType === 'Custom - ALZ');

// File names don't always match the definition name (some carry a version),
// so index the library's set definitions by name.
async function libraryFolder(folder) {
  const files = await get(`${ALZ_CONTENTS}/${folder}?ref=${encodeURIComponent(ALZ_REF)}`);
  const byName = new Map();
  for (const f of files.filter((f) => f.name.endsWith('.json'))) {
    const def = await get(`${ALZ_LIB}/${folder}/${f.name}`);
    byName.set(def.name, def);
  }
  return byName;
}
const alzSets = await libraryFolder('policy_set_definitions');
const alzDefinitions = await libraryFolder('policy_definitions');
const alzDefaults = await get(`${ALZ_LIB}/alz_policy_default_values.json`);
// Custom roles: the ALZ role files name the role in properties.roleName.
const alzRoles = [...(await libraryFolder('role_definitions')).values()];
const assignmentFiles = {};

/** One member per policy, with every reference ID it is included under. */
function mergeMembers(members) {
  const byPolicy = new Map();
  for (const m of members) {
    const seen = byPolicy.get(m.p);
    if (!seen) byPolicy.set(m.p, { ...m, ...(m.r ? { r: [...m.r] } : {}) });
    else if (m.r) seen.r = [...new Set([...(seen.r ?? []), ...m.r])];
  }
  return [...byPolicy.values()];
}

const assignments = {};
for (const name of assignmentNames) {
  const a = await get(`${ALZ_LIB}/policy_assignments/${name}.alz_policy_assignment.json`);
  const p = a.properties;
  assignmentFiles[name] = {
    parameters: p.parameters ?? {},
    nonComplianceMessages: p.nonComplianceMessages ?? [],
    ...(p.definitionVersion ? { definitionVersion: p.definitionVersion } : {}),
  };
  const isSet = p.policyDefinitionId.includes('/policySetDefinitions/');
  const builtIn = p.policyDefinitionId.startsWith('/providers/Microsoft.Authorization/');
  const defName = guidOf(p.policyDefinitionId);
  let members = [];
  let definitionName = null;
  if (isSet && !builtIn) {
    // The library's own set definition carries the effects ALZ wires to its
    // parameters, which the assignment can override.
    const set = alzSets.get(defName);
    if (!set) throw new Error(`ALZ policy set definition not found: ${defName}`);
    definitionName = set.properties.displayName;
    members = set.properties.policyDefinitions.map((ref) => {
      const pid = guidOf(ref.policyDefinitionId);
      const csv = alzInitiatives
        .filter((i) => i.initiativeId === defName || i.initiativeId.startsWith(`${defName}_`))
        .flatMap((i) => initiativeMembers.get(i.initiativeId))
        .find((m) => m.initiativePolicyId === pid);
      usePolicy(pid, csv);
      // The initiative parameter the member's effect is wired to, so a design can change it.
      const effectKey = Object.keys(ref.parameters ?? {}).find((k) => k.toLowerCase() === 'effect');
      const ep = /^\[parameters\('(.+)'\)\]$/.exec(effectKey ? String(ref.parameters[effectKey].value) : '')?.[1];
      return {
        p: pid,
        e: resolveEffect(set, ref, p.parameters) || policies[pid]?.e || '',
        r: [ref.policyDefinitionReferenceId],
        ...(ep ? { ep } : {}),
      };
    });
  } else if (isSet) {
    const set = initiativeInfo.get(defName);
    if (set) {
      definitionName = set.initiativeName;
      members = initiativeMembers.get(set.initiativeId).map((m) => {
        usePolicy(m.initiativePolicyId, m);
        return { p: m.initiativePolicyId, e: m.initiativePolicyEffectDefault || policies[m.initiativePolicyId]?.e || '', r: [m.initiativePolicyReferenceId] };
      });
    } else console.warn(`  no initiative found for ${name} (${defName})`);
  } else {
    usePolicy(defName);
    definitionName = policies[defName]?.n ?? null;
    members = [{ p: defName, e: policies[defName]?.e ?? '' }];
  }
  const effect = p.parameters?.effect?.value ?? p.parameters?.Effect?.value;
  // A single policy's assigned effect overrides its default.
  if (!isSet && typeof effect === 'string') members[0].e = effect;
  assignments[name] = {
    displayName: p.displayName,
    description: p.description,
    definitionId: p.policyDefinitionId.replace(/managementGroups\/placeholder/, 'managementGroups/{root}'),
    definitionName,
    kind: isSet ? 'initiative' : 'policy',
    source: builtIn ? 'BuiltIn' : 'ALZ',
    enforcementMode: p.enforcementMode ?? 'Default',
    // A built-in definition missing from Azure Government.
    ...(builtIn && (isSet ? initiativeInfo.get(defName)?.initiativeAzUSGov === 'false' : policies[defName]?.ng) ? { usGov: false } : {}),
    ...(typeof effect === 'string' ? { effect } : {}),
    identity: !!a.identity,
    policies: mergeMembers(members),
  };
}
console.log(`  ${assignmentNames.length} assignments across ${ALZ_ARCHETYPES.length} archetypes`);

// ALZ custom policies: the roles their DeployIfNotExists / Modify identities
// need, from the definitions themselves.
for (const [name, def] of alzDefinitions) {
  const roles = def.properties.policyRule?.then?.details?.roleDefinitionIds ?? [];
  if (policies[name] && roles.length) policies[name].r = roles.map((r) => guidOf(r).toLowerCase());
}

// Built-in initiatives the app's own decisions assign, looked up by name.
const EXTRA_INITIATIVES = {
  'sovereignty-global': 'Sovereignty Baseline - Global Policies',
  'sovereignty-confidential': 'Sovereignty Baseline - Confidential Policies',
};
const extraInitiatives = {};
for (const [key, name] of Object.entries(EXTRA_INITIATIVES)) {
  const info = [...initiativeInfo.values()].find((i) => i.initiativeName === name && i.initiativeType === 'BuiltIn');
  if (!info) throw new Error(`initiative not found: ${name}`);
  extraInitiatives[key] = {
    id: info.initiativeId,
    name,
    description: info.initiativeDescription,
    version: info.initiativeVersion,
    usGov: info.initiativeAzUSGov !== 'false',
    policies: mergeMembers(
      initiativeMembers.get(info.initiativeId).map((m) => {
        usePolicy(m.initiativePolicyId, m);
        return { p: m.initiativePolicyId, e: m.initiativePolicyEffectDefault || policies[m.initiativePolicyId]?.e || '', r: [m.initiativePolicyReferenceId] };
      }),
    ),
  };
}

// Built-in policies the app's own decisions assign.
for (const id of [
  'e56962a6-4747-49cd-b67b-bf8b01975c4c', // Allowed locations
  'e765b5de-1225-4ba3-bd56-1ac6695af988', // Allowed locations for resource groups
  '96670d01-0a4d-4649-9c89-2d3abc0a5025', // Require a tag on resource groups
  '726aca4c-86e9-4b04-b0c5-073027359532', // Inherit a tag from the resource group if missing
  '6c112d4e-5bc7-47ae-a041-ea2d9dccd749', // Not allowed resource types
  'a08ec900-254a-4555-9bf5-e42af04b5c5c', // Allowed resource types (locked parking lot)
]) usePolicy(id);

const catalog = {
  generated: new Date().toISOString().slice(0, 10),
  sources: {
    azadvertizer: AZADVERTIZER,
    azurePolicy: 'https://github.com/Azure/azure-policy',
    alzLibrary: 'https://github.com/Azure/Azure-Landing-Zones-Library',
    oscal: 'https://github.com/usnistgov/oscal-content',
  },
  frameworks,
  initiatives: extraInitiatives,
  nist: { families, controls: nistControls },
  alz: {
    ref: ALZ_REF,
    roles: alzRoles.map((r) => ({ name: r.properties.roleName, description: r.properties.description })),
    managementGroups: architecture.management_groups.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      parent: m.parent_id,
      archetype: m.archetypes[0],
    })),
    archetypes,
    assignments,
  },
  policies,
};

// Keep the previous date when nothing else changed, so an unchanged catalog
// leaves the file as it is (the scheduled update only opens a PR for real changes).
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
if (previous && JSON.stringify({ ...previous, generated: null }) === JSON.stringify({ ...catalog, generated: null }))
  catalog.generated = previous.generated;
writeFileSync(out, JSON.stringify(catalog) + '\n');

const strip = (def) => ({ name: def.name, properties: def.properties });
const library = {
  ref: ALZ_REF,
  policyDefinitions: Object.fromEntries([...alzDefinitions].map(([n, d]) => [n, strip(d)])),
  policySetDefinitions: Object.fromEntries([...alzSets].map(([n, d]) => [n, strip(d)])),
  policyAssignments: assignmentFiles,
  roleDefinitions: Object.fromEntries(alzRoles.map((r) => [r.properties.roleName, { permissions: r.properties.permissions, description: r.properties.description }])),
  defaults: alzDefaults.defaults,
};
mkdirSync(dirname(libraryOut), { recursive: true });
writeFileSync(libraryOut, JSON.stringify(library) + '\n');
// Every built-in policy, for custom assignments: loaded when the picker opens.
const policyIndexData = Object.fromEntries(
  policyRows
    // Static: the manual-attestation built-ins the regulatory initiatives include. Some built-in IDs aren't valid hex.
    .filter((p) => (p.policyType === 'BuiltIn' || p.policyType === 'Static') && /^[0-9a-z-]{36}$/i.test(p.policyId))
    .map((p) => [p.policyId, { ...policyInfo(p, undefined, 200), t: 'BuiltIn' }])
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(indexOut, JSON.stringify({ generated: catalog.generated, policies: policyIndexData }) + '\n');
console.log(`Wrote ${Object.keys(policyIndexData).length} built-in policies to ${indexOut}`);

// Every built-in initiative with its members ([policy GUID, default effect, reference ID]), for custom assignments.
const initiativeIndexData = Object.fromEntries(
  [...initiativeInfo]
    .filter(([id, info]) => info.initiativeType === 'BuiltIn' && /^[0-9a-z-]{36}$/i.test(id))
    .map(([id, info]) => [
      id,
      {
        n: info.initiativeName,
        c: info.initiativeCategory,
        v: info.initiativeVersion,
        d: (info.initiativeDescription ?? '').slice(0, 200),
        ...(info.initiativeAzUSGov === 'false' ? { ng: true } : {}),
        m: initiativeMembers.get(id).map((m) => [m.initiativePolicyId, m.initiativePolicyEffectDefault || '', m.initiativePolicyReferenceId]),
      },
    ])
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(initiativeIndexOut, JSON.stringify({ generated: catalog.generated, initiatives: initiativeIndexData }) + '\n');
console.log(`Wrote ${Object.keys(initiativeIndexData).length} built-in initiatives to ${initiativeIndexOut}`);
console.log(`Wrote ${alzDefinitions.size} ALZ policy definitions and ${alzSets.size} set definitions to ${libraryOut}`);
console.log(`Wrote ${Object.keys(policies).length} policies, ${frameworks.length} frameworks to ${out}`);
