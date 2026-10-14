import { portalInitiativeUrl, portalPolicyUrl, type Catalog, type Member } from '../lib/catalog';
import { ENFORCING_EFFECTS, effectSummary, type ControlStatus, type Note, type PlannedAssignment } from '../lib/engine';

export function Notes({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  return (
    <ul className="issues">
      {notes.map((note, i) => (
        <li key={i} className={note.level}>
          {note.text}
        </li>
      ))}
    </ul>
  );
}

export const STATUS_LABEL: Record<ControlStatus, string> = {
  enforced: 'Enforced',
  audited: 'Audited',
  pim: 'PIM',
  manual: 'Manual only',
  excluded: 'Excluded (manual)',
  none: 'No policy',
};

export const STATUS_HELP: Record<ControlStatus, string> = {
  enforced: 'At least one mapped policy is enforced (Deny, DeployIfNotExists, Modify) somewhere in the design.',
  audited: 'Mapped policies evaluate resources, but only report non-compliance.',
  pim: 'No policy evaluates it, but Privileged Identity Management addresses it (just-in-time access, MFA, approval, expiry).',
  manual: 'Only manual attestation policies: evidence is uploaded in Defender for Cloud.',
  excluded: 'Only manual attestation policies, turned off by "Exclude manual-only controls": track the evidence outside Azure.',
  none: 'No Azure Policy maps to this control; it is covered by process, not configuration.',
};

export const STATUSES: ControlStatus[] = ['enforced', 'audited', 'pim', 'manual', 'excluded', 'none'];

/** Horizontal stacked bar of control statuses. */
export function StatusBar({ counts }: { counts: Record<ControlStatus, number> }) {
  const total = STATUSES.reduce((n, s) => n + counts[s], 0);
  if (!total) return <div className="status-bar empty" />;
  return (
    <div className="status-bar">
      {STATUSES.map((s) =>
        counts[s] ? (
          <div
            key={s}
            className={`st-${s}`}
            style={{ width: `${(counts[s] / total) * 100}%` }}
            title={`${STATUS_LABEL[s]}: ${counts[s]} of ${total}`}
          />
        ) : null,
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: ControlStatus }) {
  return (
    <span className={`badge st-${status}`} title={STATUS_HELP[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export const ORIGIN_LABEL: Record<PlannedAssignment['origin'], string> = {
  alz: 'ALZ',
  framework: 'Framework',
  decision: 'Decision',
  enforcement: 'Enforcement',
};

export function OriginBadge({ origin }: { origin: PlannedAssignment['origin'] }) {
  return <span className={`badge origin-${origin}`}>{ORIGIN_LABEL[origin]}</span>;
}

export function ModeBadge({ assignment }: { assignment: PlannedAssignment }) {
  if (assignment.enforcementMode === 'DoNotEnforce')
    return (
      <span className="badge mode-dne" title="DoNotEnforce: the policy is evaluated and reported, but never blocks or remediates.">
        DoNotEnforce
      </span>
    );
  const enforcing = assignment.policies.some((m) => ENFORCING_EFFECTS.has(m.e));
  return enforcing ? (
    <span className="badge mode-enforced">Enforced</span>
  ) : (
    <span className="badge mode-audit">Audit</span>
  );
}

export function EffectSummary({ members }: { members: Member[] }) {
  const { label, counts } = effectSummary(members);
  const detail = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `${n} ${e}`)
    .join(' · ');
  return (
    <span className="effect" title={detail}>
      {label === 'Mixed' ? detail : label}
    </span>
  );
}

/** Link to the definition on AzAdvertizer (built-in GUIDs and ALZ names both resolve). */
export function definitionUrl(a: PlannedAssignment): string | null {
  if (a.definitionSource === 'Custom') return null;
  const id = a.definitionId.split('/').pop()!;
  return a.kind === 'initiative' ? portalInitiativeUrl(id) : portalPolicyUrl(id);
}

export function PolicyLink({ catalog, id }: { catalog: Catalog; id: string }) {
  const p = catalog.policies[id];
  return (
    <a href={portalPolicyUrl(id)} target="_blank" rel="noreferrer" title={p?.d}>
      {p?.n ?? id}
    </a>
  );
}
