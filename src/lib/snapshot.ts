// Policy snapshots: one shape for "what is assigned where" that comes either
// from a design or from an Azure tenant (an Azure Resource Graph export), so the
// two can be compared with each other and against the frameworks.

import type { Catalog } from './catalog';
import { ENFORCING_EFFECTS, type Design } from './engine';

export interface SnapshotMg {
  /** Management group name (ID), or "subscription:<id>" / "resourceGroup:<id>" for other scopes. */
  id: string;
  displayName: string;
  parentId: string | null;
}

export interface SnapshotMember {
  /** Built-in policy GUID, or a custom definition's name (lower case). */
  p: string;
  /** Effect it runs with (after parameters and overrides), or "" when unknown. */
  e: string;
}

export interface SnapshotAssignment {
  /** SnapshotMg id of its scope. */
  scope: string;
  name: string;
  displayName: string;
  /** Built-in GUID or custom definition name, lower case, without an ALZ "_yyyymmdd" version suffix. */
  definitionKey: string;
  definitionName: string;
  kind: 'policy' | 'initiative';
  enforcementMode: 'Default' | 'DoNotEnforce';
  members: SnapshotMember[];
  /** False when the initiative's members couldn't be resolved. */
  membersKnown: boolean;
  /** Hidden assignments Microsoft manages (sys.*). */
  system?: boolean;
}

export interface SnapshotExemption {
  assignment: string;
  /** SnapshotMg id of the exempted scope. */
  scope: string;
  category: string;
  displayName: string;
  /** Exempted reference IDs; empty for the whole assignment. */
  references: string[];
  expiresOn?: string;
}

export interface PolicySnapshot {
  label: string;
  kind: 'design' | 'azure';
  /** ISO time, for an import. */
  importedAt?: string;
  mgs: SnapshotMg[];
  assignments: SnapshotAssignment[];
  exemptions: SnapshotExemption[];
  /** Framework keys whose built-in initiative is assigned. */
  frameworks: string[];
  notes: string[];
}

/** "Enforce-Guardrails-KeyVault_20260203" and "Enforce-Guardrails-KeyVault" are the same definition. */
export const definitionKey = (idOrName: string) =>
  (idOrName.split('/').pop() ?? idOrName).toLowerCase().replace(/_\d{8}$/, '');

const lowerIndex = new WeakMap<Catalog, Map<string, Catalog['policies'][string]>>();

/** A catalog policy by key, ignoring case (snapshots use lower-case keys; ALZ names keep theirs in the catalog). */
export function catalogPolicy(catalog: Catalog, p: string): Catalog['policies'][string] | undefined {
  let index = lowerIndex.get(catalog);
  if (!index) {
    index = new Map(Object.entries(catalog.policies).map(([k, v]) => [k.toLowerCase(), v]));
    lowerIndex.set(catalog, index);
  }
  return index.get(p.toLowerCase());
}

/** A policy's display name from the catalog, else its key. */
export function policyLabel(catalog: Catalog, p: string): string {
  return catalogPolicy(catalog, p)?.n ?? p;
}

// --- From a design --------------------------------------------------------------

export function designSnapshot(design: Design, label: string): PolicySnapshot {
  return {
    label,
    kind: 'design',
    mgs: design.mgs.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      parentId: m.parent ? (design.mgs.find((x) => x.role === m.parent)?.id ?? null) : null,
    })),
    assignments: design.mgs.flatMap((m) =>
      m.assignments.map((a) => ({
        scope: m.id,
        name: a.name,
        displayName: a.displayName,
        definitionKey: definitionKey(a.definitionId),
        definitionName: a.definitionName,
        kind: a.kind,
        enforcementMode: a.enforcementMode,
        members: a.policies.map((p) => ({ p: p.p.toLowerCase(), e: p.e })),
        membersKnown: true,
      })),
    ),
    exemptions: design.mgs.flatMap((m) =>
      m.assignments.flatMap((a) =>
        a.exemptions.map((e) => ({
          assignment: a.name,
          scope:
            e.scope.kind === 'managementGroup'
              ? (design.mgs.find((x) => x.role === (e.scope as { role: string }).role)?.id ?? '')
              : `${e.scope.kind}:${e.scope.id}`,
          category: e.category,
          displayName: e.reason,
          references: a.policies.filter((p) => e.policies.includes(p.p)).flatMap((p) => p.r ?? []),
          ...(e.expiresOn ? { expiresOn: e.expiresOn } : {}),
        })),
      ),
    ),
    frameworks: design.coverage.map((c) => c.key),
    notes: [],
  };
}

// --- From Azure -----------------------------------------------------------------

/**
 * The Azure Resource Graph queries the import expects. Resource Graph lets a
 * query use policyresources as a joined table only once, so there are two:
 * management groups, assignments, exemptions and custom definitions; then the
 * built-in definitions and initiatives that are assigned (so their member
 * policies can be resolved).
 */
export const AZURE_IMPORT_QUERIES = [
  [
    "policyresources | where type in~ ('microsoft.authorization/policyassignments', 'microsoft.authorization/policyexemptions')",
    "  or (type in~ ('microsoft.authorization/policydefinitions', 'microsoft.authorization/policysetdefinitions') and tostring(properties.policyType) =~ 'Custom')",
    '| project id, name, type, properties',
    "| union (resourcecontainers | where type =~ 'microsoft.management/managementgroups' | project id, name, type, properties)",
  ].join('\n'),
  [
    "policyresources | where type =~ 'microsoft.authorization/policyassignments'",
    '| project definitionId = tolower(tostring(properties.policyDefinitionId)) | distinct definitionId',
    "| join kind=inner (policyresources | where type in~ ('microsoft.authorization/policydefinitions', 'microsoft.authorization/policysetdefinitions')",
    "    and tostring(properties.policyType) !~ 'Custom' | extend definitionId = tolower(id)) on definitionId",
    '| project id, name, type, properties',
  ].join('\n'),
];

const oneLine = (q: string) => q.replace(/\n\s*/g, ' ');
const ARG = 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01';

/** Commands that run both queries, page through each (1,000 rows a page) and save every row. */
export const AZURE_IMPORT_COMMANDS: { label: string; command: string }[] = [
  {
    label: 'Bash (az CLI, jq)',
    command: [
      ...AZURE_IMPORT_QUERIES.map((q, i) => `q${i + 1}="${oneLine(q).replace(/"/g, '\\"')}"`),
      ': > azure-policy.json',
      `for q in ${AZURE_IMPORT_QUERIES.map((_, i) => `"$q${i + 1}"`).join(' ')}; do`,
      '  token=""',
      '  while :; do',
      `    body=$(jq -n --arg q "$q" --arg t "$token" '{query: $q, options: ({"$top": 1000, resultFormat: "objectArray"} + (if $t == "" then {} else {"$skipToken": $t} end))}')`,
      `    page=$(az rest --method post --url "${ARG}" --body "$body")`,
      '    echo "$page" >> azure-policy.json',
      `    token=$(jq -r '."$skipToken" // empty' <<<"$page"); [ -z "$token" ] && break`,
      '  done',
      'done',
    ].join('\n'),
  },
  {
    label: 'PowerShell (az CLI)',
    command: [
      `$queries = @(${AZURE_IMPORT_QUERIES.map((q) => `"${oneLine(q).replace(/"/g, '`"')}"`).join(', ')})`,
      'Remove-Item azure-policy.json -ErrorAction SilentlyContinue',
      'foreach ($q in $queries) {',
      '  $token = $null',
      '  do {',
      "    $options = @{ '$top' = 1000; resultFormat = 'objectArray' }; if ($token) { $options['$skipToken'] = $token }",
      '    @{ query = $q; options = $options } | ConvertTo-Json -Depth 4 | Set-Content body.json -Encoding utf8',
      `    $page = az rest --method post --url "${ARG}" --body '@body.json' | Out-String`,
      '    Add-Content azure-policy.json $page',
      "    $token = ($page | ConvertFrom-Json).'$skipToken'",
      '  } while ($token)',
      '}',
    ].join('\n'),
  },
];

/** Every top-level JSON value in the text (pages pasted together, with stray CLI output between them skipped). */
export function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.slice(i).search(/[[{]/);
    if (start < 0) break;
    let pos = i + start;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = pos; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (c === '\\') j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      values.push(JSON.parse(text.slice(pos, end + 1)));
      i = end + 1;
    } catch {
      i = pos + 1;
    }
  }
  return values;
}

type Row = { id: string; name: string; type: string; properties: Record<string, unknown> };

/** Keys case-insensitively. */
const get = (o: unknown, key: string): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  const k = Object.keys(o).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : (o as Record<string, unknown>)[k];
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Rows from Resource Graph output: REST/az graph ({ data: [...] }), PowerShell (an array), or single rows. */
function rows(values: unknown[]): Row[] {
  const out: Row[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const data = get(v, 'data');
    if (Array.isArray(data)) return data.forEach(visit);
    const id = str(get(v, 'id'));
    const type = str(get(v, 'type')).toLowerCase();
    if (id && type) out.push({ id, name: str(get(v, 'name')) || (id.split('/').pop() ?? ''), type, properties: (get(v, 'properties') as Record<string, unknown>) ?? {} });
  };
  values.forEach(visit);
  // Pages can overlap; keep one row per id.
  return [...new Map(out.map((r) => [r.id.toLowerCase(), r])).values()];
}

/** The scope part of a resource ID, as a SnapshotMg id. */
function scopeOf(id: string): string {
  const scope = id.replace(/\/providers\/Microsoft\.Authorization\/policy(Assignments|Exemptions)\/[^/]+$/i, '');
  const mg = /^\/providers\/Microsoft\.Management\/managementGroups\/([^/]+)$/i.exec(scope);
  if (mg) return mg[1];
  if (/^\/subscriptions\/[^/]+$/i.test(scope)) return `subscription:${scope.split('/')[2]}`;
  if (/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(scope)) return `resourceGroup:${scope}`;
  return `resource:${scope}`;
}

/** The effect a reference runs with: a literal, or a parameter resolved from the assignment's values or the default. */
function resolveEffect(
  value: unknown,
  setParameters: Record<string, unknown>,
  assigned: Record<string, unknown>,
): string | null {
  if (typeof value !== 'string') return null;
  const m = /^\[parameters\('(.+)'\)\]$/i.exec(value);
  if (!m) return value;
  const fromAssignment = get(get(assigned, m[1]), 'value');
  const v = fromAssignment ?? get(get(setParameters, m[1]), 'defaultValue');
  return typeof v === 'string' ? v : null;
}

const capital = (e: string) => (e ? e[0].toUpperCase() + e.slice(1) : e);

/** Reads an Azure Resource Graph export (see AZURE_IMPORT_COMMANDS) into a snapshot. */
export function parseAzureImport(text: string, catalog: Catalog, label = 'Azure', now = new Date()): PolicySnapshot {
  const all = rows(jsonValues(text));
  if (!all.length) throw new Error('No Azure Resource Graph rows found. Paste the output of the import command.');
  const notes: string[] = [];
  const definitions = new Map(
    all.filter((r) => /\/policy(set)?definitions$/.test(r.type)).map((r) => [r.id.toLowerCase(), r]),
  );
  // Custom definitions by name too, for initiatives that reference them at another scope.
  const customByName = new Map(
    all.filter((r) => r.type.endsWith('/policydefinitions') && str(r.properties.policyType) === 'Custom').map((r) => [r.name.toLowerCase(), r]),
  );
  const policyKey = (id: string) => lastId(id).toLowerCase();

  // Management groups: from the rows, plus any scope an assignment uses.
  const mgs = new Map<string, SnapshotMg>();
  for (const r of all.filter((x) => x.type === 'microsoft.management/managementgroups')) {
    const parent = str(get(get(get(r.properties, 'details'), 'parent'), 'id'));
    mgs.set(r.name.toLowerCase(), {
      id: r.name,
      displayName: str(get(r.properties, 'displayName')) || r.name,
      parentId: parent ? (parent.split('/').pop() ?? null) : null,
    });
  }
  const ensureScope = (scope: string) => {
    if (mgs.has(scope.toLowerCase())) return;
    const [kind, rest] = scope.includes(':') ? [scope.slice(0, scope.indexOf(':')), scope.slice(scope.indexOf(':') + 1)] : ['mg', scope];
    mgs.set(scope.toLowerCase(), {
      id: scope,
      displayName: kind === 'mg' ? scope : kind === 'subscription' ? `Subscription ${rest}` : rest.split('/').pop() ?? rest,
      parentId: null,
    });
  };

  let unresolved = 0;
  const assignments: SnapshotAssignment[] = all
    .filter((r) => r.type === 'microsoft.authorization/policyassignments')
    .map((r) => {
      const p = r.properties;
      const defId = str(get(p, 'policyDefinitionId'));
      const isSet = /\/policySetDefinitions\//i.test(defId);
      const assigned = (get(p, 'parameters') as Record<string, unknown>) ?? {};
      const scope = scopeOf(r.id);
      ensureScope(scope);
      // Overrides that set an effect for some references (e.g. Disabled for manual policies).
      const overrides = new Map<string, string>();
      for (const o of (get(p, 'overrides') as unknown[]) ?? [])
        if (str(get(o, 'kind')).toLowerCase() === 'policyeffect')
          for (const s of (get(o, 'selectors') as unknown[]) ?? [])
            if (str(get(s, 'kind')).toLowerCase() === 'policydefinitionreferenceid')
              for (const ref of (get(s, 'in') as string[]) ?? []) overrides.set(ref.toLowerCase(), capital(str(get(o, 'value'))));

      let members: SnapshotMember[] = [];
      let membersKnown = true;
      const def = definitions.get(defId.toLowerCase());
      if (isSet) {
        const refs = (get(def?.properties, 'policyDefinitions') as unknown[]) ?? null;
        if (refs) {
          const setParameters = (get(def!.properties, 'parameters') as Record<string, unknown>) ?? {};
          members = refs.map((ref) => {
            const refDefId = str(get(ref, 'policyDefinitionId'));
            const key = policyKey(refDefId);
            const refParams = (get(ref, 'parameters') as Record<string, unknown>) ?? {};
            const effectKey = Object.keys(refParams).find((k) => k.toLowerCase() === 'effect');
            const override = overrides.get(str(get(ref, 'policyDefinitionReferenceId')).toLowerCase());
            const resolved = effectKey ? resolveEffect(get(refParams[effectKey], 'value'), setParameters, assigned) : null;
            const fallback = catalogPolicy(catalog, key)?.e ?? definitionEffect(definitions.get(refDefId.toLowerCase()) ?? customByName.get(key));
            return { p: key, e: capital(override ?? resolved ?? fallback ?? '') };
          });
        } else {
          // A built-in initiative the export didn't include: the catalog may know it.
          const known = knownInitiative(catalog, lastId(defId));
          if (known) members = known;
          else {
            membersKnown = false;
            unresolved++;
          }
        }
      } else {
        const key = policyKey(defId);
        const effectKey = Object.keys(assigned).find((k) => k.toLowerCase() === 'effect');
        const fromParam = effectKey ? str(get(assigned[effectKey], 'value')) : '';
        members = [{ p: key, e: capital(fromParam || (catalogPolicy(catalog, key)?.e ?? definitionEffect(def ?? customByName.get(key)) ?? '')) }];
      }
      return {
        scope,
        name: r.name,
        displayName: str(get(p, 'displayName')) || r.name,
        definitionKey: definitionKey(defId),
        definitionName: str(get(def?.properties, 'displayName')) || lastId(defId),
        kind: isSet ? ('initiative' as const) : ('policy' as const),
        enforcementMode: str(get(p, 'enforcementMode')) === 'DoNotEnforce' ? ('DoNotEnforce' as const) : ('Default' as const),
        members: [...new Map(members.map((m) => [m.p, m])).values()],
        membersKnown,
        ...(str(get(p, 'assignmentType')) === 'SystemHidden' || r.name.startsWith('sys.') ? { system: true } : {}),
      };
    });
  if (unresolved) notes.push(`${unresolved} assignment${unresolved === 1 ? '' : 's'} use an initiative the export didn't include, so their policies are unknown. Re-run the full import query.`);

  const exemptions: SnapshotExemption[] = all
    .filter((r) => r.type === 'microsoft.authorization/policyexemptions')
    .map((r) => {
      const scope = scopeOf(r.id);
      ensureScope(scope);
      return {
        assignment: lastId(str(get(r.properties, 'policyAssignmentId'))),
        scope,
        category: str(get(r.properties, 'exemptionCategory')),
        displayName: str(get(r.properties, 'displayName')) || r.name,
        references: (get(r.properties, 'policyDefinitionReferenceIds') as string[]) ?? [],
        ...(str(get(r.properties, 'expiresOn')) ? { expiresOn: str(get(r.properties, 'expiresOn')).slice(0, 10) } : {}),
      };
    });

  if (![...mgs.values()].some((m) => !m.id.includes(':')))
    notes.push('No management groups were readable; the hierarchy is built from the assignment scopes.');
  const frameworkIds = new Map(catalog.frameworks.map((f) => [f.id.toLowerCase(), f.key]));
  return {
    label,
    kind: 'azure',
    importedAt: now.toISOString(),
    mgs: [...mgs.values()],
    assignments,
    exemptions,
    frameworks: [...new Set(assignments.map((a) => frameworkIds.get(a.definitionKey)).filter((k): k is string => !!k))],
    notes,
  };
}

const lastId = (id: string) => id.split('/').pop() ?? id;

/** The effect a policy definition runs with by default: a literal, or its effect parameter's default. */
function definitionEffect(def: Row | undefined): string | null {
  if (!def) return null;
  const effect = get(get(get(def.properties, 'policyRule'), 'then'), 'effect');
  return resolveEffect(effect, (get(def.properties, 'parameters') as Record<string, unknown>) ?? {}, {});
}

/** Members of a built-in initiative the catalog knows: a framework, an ALZ assignment's or an extra initiative. */
function knownInitiative(catalog: Catalog, guid: string): SnapshotMember[] | null {
  const g = guid.toLowerCase();
  const framework = catalog.frameworks.find((f) => f.id.toLowerCase() === g);
  if (framework) return framework.refs.map((r) => ({ p: r.p, e: r.e }));
  const alz = Object.values(catalog.alz.assignments).find((a) => a.kind === 'initiative' && a.definitionId.toLowerCase().endsWith(g));
  if (alz) return alz.policies.map((m) => ({ p: m.p.toLowerCase(), e: m.e }));
  const extra = Object.values(catalog.initiatives).find((i) => i.id.toLowerCase() === g);
  if (extra) return extra.policies.map((m) => ({ p: m.p, e: m.e }));
  return null;
}

/** Whether a member's effect enforces (blocks or remediates) when its assignment is enforced. */
export const enforces = (a: SnapshotAssignment, m: SnapshotMember) => a.enforcementMode === 'Default' && ENFORCING_EFFECTS.has(m.e);
/** Whether a member is evaluated at all. */
export const evaluates = (m: SnapshotMember) => m.e.toLowerCase() !== 'disabled';
