// A migration plan from what's deployed in Azure (an import) to a design: the
// management groups to create, the assignments to add, change, enforce and
// remove, in an order that reports before it blocks.

import { ENFORCING_EFFECTS, type Design, type PlannedAssignment, type PlannedMg } from './engine';
import { definitionKey, type PolicySnapshot, type SnapshotAssignment } from './snapshot';

export type StepKind = 'createMg' | 'add' | 'relax' | 'redefine' | 'remediate' | 'enforce' | 'remove';

export interface MigrationStep {
  kind: StepKind;
  /** Management group (or other scope) ID. */
  scope: string;
  scopeName: string;
  /** Assignment name, for assignment steps. */
  assignment?: string;
  title: string;
  detail: string;
  /** Resources currently non-compliant with the policies that would start blocking or remediating. */
  nonCompliant?: number;
  /** An Azure CLI command for steps the IaC can't do (removals). */
  command?: string;
}

export type PhaseKey = 'groups' | 'audit' | 'review' | 'enforce' | 'cleanup';

export interface MigrationPhase {
  key: PhaseKey;
  title: string;
  description: string;
  steps: MigrationStep[];
}

/** What already exists in Azure, for Terraform import blocks. */
export interface ExistingResources {
  /** Management group IDs (lower case). */
  managementGroups: string[];
  /** "<management group id>/<assignment name>" (lower case). */
  assignments: string[];
  /** Custom policy and initiative definition resource IDs (lower case). */
  definitions: string[];
}

export interface MigrationPlan {
  target: string;
  current: string;
  phases: MigrationPhase[];
  /** Design assignments already in Azure as designed. */
  unchanged: number;
  /** Design management groups that already exist. */
  matchedMgs: number;
  /** "<management group id>/<assignment name>" of the design assignments deployed in DoNotEnforce first. */
  auditFirst: string[];
  existing: ExistingResources;
  /** When no design management group exists in Azure but the tenant looks like ALZ: its prefix. */
  suggestedPrefix?: string;
  notes: string[];
}

const key = (scope: string, name: string) => `${scope}/${name}`.toLowerCase();
const isEnforcing = (a: PlannedAssignment) => a.policies.some((m) => ENFORCING_EFFECTS.has(m.e));

/** The ARM scope of a snapshot scope ("subscription:<id>", "resourceGroup:<id>" or a management group ID). */
export function scopeResourceId(scope: string): string {
  if (scope.startsWith('subscription:')) return `/subscriptions/${scope.slice('subscription:'.length)}`;
  if (scope.startsWith('resourceGroup:') || scope.startsWith('resource:')) return scope.slice(scope.indexOf(':') + 1);
  return `/providers/Microsoft.Management/managementGroups/${scope}`;
}

/** Resources non-compliant with the assignment's enforcing policies, per the import's compliance state. */
function nonCompliantFor(a: PlannedAssignment, current: PolicySnapshot): number | undefined {
  if (!current.compliance) return undefined;
  return a.policies
    .filter((m) => ENFORCING_EFFECTS.has(m.e))
    .reduce((n, m) => n + (current.compliance![m.p.toLowerCase()]?.nonCompliant ?? 0), 0);
}

export function buildMigrationPlan(design: Design, target: string, current: PolicySnapshot): MigrationPlan {
  const notes: string[] = [];
  const azureMgs = new Map(current.mgs.map((m) => [m.id.toLowerCase(), m]));
  const azure = current.assignments.filter((a) => !a.system);
  const byKey = new Map(azure.map((a) => [key(a.scope, a.name), a]));
  const mgName = (id: string) => design.mgs.find((m) => m.id.toLowerCase() === id.toLowerCase())?.displayName ?? azureMgs.get(id.toLowerCase())?.displayName ?? id;

  // --- Management groups ---
  const groups: MigrationStep[] = [];
  const existingMgs: string[] = [];
  for (const m of design.mgs) {
    if (azureMgs.has(m.id.toLowerCase())) {
      existingMgs.push(m.id.toLowerCase());
      continue;
    }
    const parent = design.mgs.find((p) => p.role === m.parent);
    groups.push({
      kind: 'createMg',
      scope: m.id,
      scopeName: m.displayName,
      title: `Create ${m.displayName}`,
      detail: `Management group ${m.id}${parent ? `, under ${parent.displayName}` : ', under the tenant root group'}.`,
    });
  }
  let suggestedPrefix: string | undefined;
  if (!existingMgs.length) {
    const lz = current.mgs.find((m) => /-landingzones$/i.test(m.id));
    if (lz) suggestedPrefix = lz.id.replace(/-landingzones$/i, '');
    notes.push(
      suggestedPrefix
        ? `None of the design's management groups exist in Azure. The tenant looks like an ALZ deployment with the prefix "${suggestedPrefix}"; set the design's prefix to it to plan against those groups instead of beside them.`
        : "None of the design's management groups exist in Azure, so the plan creates the whole hierarchy beside what's there.",
    );
  }

  // --- Assignments ---
  const audit: MigrationStep[] = [];
  const enforce: MigrationStep[] = [];
  const cleanup: MigrationStep[] = [];
  const auditFirst: string[] = [];
  const existingAssignments: string[] = [];
  const accounted = new Set<string>();
  let unchanged = 0;

  const enforceLater = (mg: PlannedMg, a: PlannedAssignment, why: string) => {
    auditFirst.push(key(mg.id, a.name));
    enforce.push({
      kind: 'enforce',
      scope: mg.id,
      scopeName: mg.displayName,
      assignment: a.name,
      title: `Enforce ${a.displayName}`,
      detail: why,
      nonCompliant: nonCompliantFor(a, current),
    });
  };

  for (const mg of design.mgs) {
    for (const a of mg.assignments) {
      const wantsEnforced = a.enforcementMode === 'Default' && isEnforcing(a);
      const same = byKey.get(key(mg.id, a.name));
      if (same) {
        accounted.add(key(same.scope, same.name));
        existingAssignments.push(key(mg.id, a.name));
        if (same.definitionKey !== definitionKey(a.definitionId)) {
          audit.push({
            kind: 'redefine',
            scope: mg.id,
            scopeName: mg.displayName,
            assignment: a.name,
            title: `Change ${a.name} to ${a.definitionName}`,
            detail: `Assigns ${same.definitionName} in Azure today. Azure can't change an assignment's definition, so it's deleted and created again${wantsEnforced ? ', in DoNotEnforce first' : ''}.`,
          });
          if (wantsEnforced) enforceLater(mg, a, 'Recreated with a new definition in DoNotEnforce first.');
        } else if (same.enforcementMode === a.enforcementMode) {
          unchanged++;
        } else if (a.enforcementMode === 'DoNotEnforce') {
          audit.push({
            kind: 'relax',
            scope: mg.id,
            scopeName: mg.displayName,
            assignment: a.name,
            title: `Report only: ${a.displayName}`,
            detail: 'Enforced in Azure today; the design sets it to DoNotEnforce.',
          });
        } else if (isEnforcing(a)) {
          enforceLater(mg, a, 'In Azure already, in DoNotEnforce.');
        } else unchanged++;
        continue;
      }
      // The same definition under another name at this scope is replaced.
      const replaced = azure.filter(
        (x) => x.scope.toLowerCase() === mg.id.toLowerCase() && x.definitionKey === definitionKey(a.definitionId) && !accounted.has(key(x.scope, x.name)),
      );
      for (const r of replaced) {
        accounted.add(key(r.scope, r.name));
        cleanup.push(removeStep(r, mgName(r.scope), `Replaced by ${a.name}, which assigns the same definition.`));
      }
      audit.push({
        kind: 'add',
        scope: mg.id,
        scopeName: mg.displayName,
        assignment: a.name,
        title: `Assign ${a.displayName}`,
        detail:
          (wantsEnforced ? 'In DoNotEnforce first, to report before it blocks or remediates.' : a.enforcementMode === 'DoNotEnforce' ? 'Report only, as designed.' : 'Audit only, so enforced as designed.') +
          (replaced.length ? ` Replaces ${replaced.map((r) => r.name).join(', ')}.` : ''),
      });
      if (wantsEnforced) enforceLater(mg, a, 'Added in DoNotEnforce in phase 2.');
    }
  }

  // Assignments in Azure the design doesn't have.
  const designMgIds = new Set(design.mgs.map((m) => m.id.toLowerCase()));
  // The tenant root group's ID is the tenant ID; what's assigned there applies under the design too.
  const tenantRoot = current.mgs.find((m) => !m.parentId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.id));
  let outside = 0;
  let atTenantRoot = 0;
  for (const x of azure) {
    if (accounted.has(key(x.scope, x.name))) continue;
    if (designMgIds.has(x.scope.toLowerCase()))
      cleanup.push(removeStep(x, mgName(x.scope), 'Not in the design. Keep it instead by adding it to the design as a custom assignment.'));
    else if (tenantRoot && x.scope.toLowerCase() === tenantRoot.id.toLowerCase()) atTenantRoot++;
    else outside++;
  }
  if (atTenantRoot)
    notes.push(`${atTenantRoot} assignment${atTenantRoot === 1 ? ' is' : 's are'} at the tenant root group, so ${atTenantRoot === 1 ? 'it applies' : 'they apply'} to the design's management groups too. Check ${atTenantRoot === 1 ? 'it doesn\'t' : 'they don\'t'} conflict with the design.`);
  if (outside)
    notes.push(`${outside} assignment${outside === 1 ? ' is' : 's are'} at scopes outside the design's management groups (other groups, subscriptions, resource groups) and left as they are.`);
  if (!current.compliance)
    notes.push("The import has no compliance state, so the plan can't tell how many resources each enforcement would affect. Import again with query 3.");

  enforce.sort((x, y) => (x.nonCompliant ?? 0) - (y.nonCompliant ?? 0) || x.title.localeCompare(y.title));
  const review: MigrationStep[] = enforce
    .filter((s) => (s.nonCompliant ?? 0) > 0)
    .map((s) => ({
      kind: 'remediate' as const,
      scope: s.scope,
      scopeName: s.scopeName,
      assignment: s.assignment,
      title: `Fix or exempt ${s.nonCompliant!.toLocaleString()} non-compliant resources before enforcing ${s.title.replace(/^Enforce /, '')}`,
      detail: 'Deny policies will block changes to them and DeployIfNotExists / Modify policies will remediate them. Run remediation tasks, fix them, or add exemptions.',
      nonCompliant: s.nonCompliant,
    }))
    .sort((x, y) => (y.nonCompliant ?? 0) - (x.nonCompliant ?? 0));

  const phases: MigrationPhase[] = [
    {
      key: 'groups',
      title: '1. Management groups',
      description: 'Create the management groups the design adds. Existing ones are kept.',
      steps: groups,
    },
    {
      key: 'audit',
      title: '2. Assign in report-only mode',
      description:
        'Deploy the "audit first" export: new assignments that would block or remediate start in DoNotEnforce, so they report without changing anything. Exemptions deploy with them.',
      steps: audit,
    },
    {
      key: 'review',
      title: '3. Review compliance',
      description: 'Wait for a compliance scan (about a day, or start one with az policy state trigger-scan), then deal with what the enforcement would affect.',
      steps: review,
    },
    {
      key: 'enforce',
      title: '4. Enforce',
      description: 'Deploy the full design export: these switch to Default. The plan orders them by how many resources they affect, fewest first; enforce in that order across a few deployments if you prefer.',
      steps: enforce,
    },
    {
      key: 'cleanup',
      title: '5. Clean up',
      description: "Remove the assignments the design replaces or doesn't have. The export doesn't delete anything, so these are Azure CLI commands.",
      steps: cleanup,
    },
  ];

  return {
    target,
    current: current.label,
    phases,
    unchanged,
    matchedMgs: existingMgs.length,
    auditFirst,
    existing: { managementGroups: existingMgs, assignments: existingAssignments, definitions: current.definitions ?? [] },
    ...(suggestedPrefix ? { suggestedPrefix } : {}),
    notes,
  };
}

function removeStep(x: SnapshotAssignment, scopeName: string, why: string): MigrationStep {
  return {
    kind: 'remove',
    scope: x.scope,
    scopeName,
    assignment: x.name,
    title: `Remove ${x.displayName}`,
    detail: why,
    command: `az policy assignment delete --name "${x.name}" --scope "${scopeResourceId(x.scope)}"`,
  };
}

/** The design with the plan's "audit first" assignments in DoNotEnforce: what phase 2 deploys. */
export function auditFirstDesign(design: Design, plan: MigrationPlan): Design {
  const first = new Set(plan.auditFirst);
  return {
    ...design,
    mgs: design.mgs.map((mg) => ({
      ...mg,
      assignments: mg.assignments.map((a) =>
        first.has(key(mg.id, a.name))
          ? { ...a, enforcementMode: 'DoNotEnforce' as const, change: 'DoNotEnforce until phase 4 of the migration plan.' }
          : a,
      ),
    })),
  };
}

/** The plan as Markdown, for the export and to share. */
export function migrationMarkdown(plan: MigrationPlan): string {
  const lines = [
    `# Migration plan: ${plan.current} → ${plan.target}`,
    '',
    `${plan.matchedMgs} of the design's management groups exist in Azure; ${plan.unchanged} assignments are already as designed.`,
    ...plan.notes.map((n) => `\n> ${n}`),
  ];
  for (const p of plan.phases) {
    lines.push('', `## ${p.title}`, '', p.description, '');
    if (!p.steps.length) lines.push('Nothing to do.');
    for (const s of p.steps) {
      lines.push(`- [ ] **${s.title}** (${s.scopeName}${s.assignment ? `, \`${s.assignment}\`` : ''}). ${s.detail}${s.nonCompliant ? ` Non-compliant resources today: ${s.nonCompliant}.` : ''}`);
      if (s.command) lines.push('', '  ```bash', `  ${s.command}`, '  ```');
    }
  }
  return lines.join('\n') + '\n';
}
