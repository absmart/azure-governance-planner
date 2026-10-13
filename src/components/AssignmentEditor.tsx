import { useState } from 'react';
import type { Catalog } from '../lib/catalog';
import {
  overrideKey,
  type AssignmentOverride,
  type Design,
  type DesignInput,
  type Exemption,
  type PlannedAssignment,
  type PlannedMg,
  type ScopeRef,
} from '../lib/engine';

/** A management group and every group under it. */
export function descendants(design: Design, mg: PlannedMg): PlannedMg[] {
  const out: PlannedMg[] = [mg];
  for (let i = 0; i < out.length; i++) out.push(...design.mgs.filter((m) => m.parent === out[i].role));
  return out;
}

const SUBSCRIPTION = /^(\/subscriptions\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_GROUP = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+$/i;

/** "id" lines to subscription / resource group scopes; null when a line is neither. */
function parseScopeIds(text: string): ScopeRef[] | null {
  const out: ScopeRef[] = [];
  for (const line of text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean)) {
    if (RESOURCE_GROUP.test(line)) out.push({ kind: 'resourceGroup', id: line });
    else if (SUBSCRIPTION.test(line)) out.push({ kind: 'subscription', id: line.replace(/^\/subscriptions\//i, '') });
    else return null;
  }
  return out;
}

const scopeIdText = (scopes: ScopeRef[] = []) =>
  scopes
    .filter((s) => s.kind !== 'managementGroup')
    .map((s) => (s.kind === 'subscription' ? `/subscriptions/${s.id}` : s.kind === 'resourceGroup' ? s.id : ''))
    .join('\n');

/** Changes to one assignment: enforcement mode, removal, excluded scopes, parameters. */
export function OverrideEditor(props: {
  design: Design;
  mg: PlannedMg;
  assignment: PlannedAssignment;
  input: DesignInput;
  onChange: (input: DesignInput) => void;
}) {
  const { design, mg, assignment: a, input, onChange } = props;
  const key = overrideKey(mg.role, a.name);
  const current: AssignmentOverride = input.overrides[key] ?? {};
  const [ids, setIds] = useState(scopeIdText(current.notScopes));
  const [params, setParams] = useState(current.parameters ? JSON.stringify(current.parameters, null, 2) : '');
  const [error, setError] = useState<string | null>(null);

  const save = (next: AssignmentOverride) => {
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && v && !Object.keys(v).length)),
    ) as AssignmentOverride;
    const overrides = { ...input.overrides };
    if (Object.keys(cleaned).length) overrides[key] = cleaned;
    else delete overrides[key];
    onChange({ ...input, overrides });
  };

  const children = descendants(design, mg).slice(1);
  const excludedRoles = new Set((current.notScopes ?? []).flatMap((s) => (s.kind === 'managementGroup' ? [s.role] : [])));
  const toggleChild = (role: PlannedMg['role'], on: boolean) => {
    const others = (current.notScopes ?? []).filter((s) => !(s.kind === 'managementGroup' && s.role === role));
    save({ ...current, notScopes: on ? [...others, { kind: 'managementGroup', role }] : others });
  };
  const applyIds = () => {
    const parsed = parseScopeIds(ids);
    if (!parsed) return setError('Use subscription IDs or /subscriptions/<id>/resourceGroups/<name>, one per line.');
    setError(null);
    save({ ...current, notScopes: [...(current.notScopes ?? []).filter((s) => s.kind === 'managementGroup'), ...parsed] });
  };
  const applyParams = () => {
    if (!params.trim()) {
      setError(null);
      return save({ ...current, parameters: undefined });
    }
    try {
      const value = JSON.parse(params);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      setError(null);
      save({ ...current, parameters: value });
    } catch {
      setError('Parameters must be a JSON object, for example { "effect": "Audit" }.');
    }
  };

  return (
    <div className="editor">
      <h4>Override</h4>
      <div className="row">
        <label>
          Enforcement
          <select
            value={current.enforcementMode ?? ''}
            onChange={(e) => save({ ...current, enforcementMode: (e.target.value || undefined) as AssignmentOverride['enforcementMode'] })}
          >
            <option value="">As designed</option>
            <option value="Default">Enforce (Default)</option>
            <option value="DoNotEnforce">DoNotEnforce (report only)</option>
          </select>
        </label>
        <button className="danger" onClick={() => save({ ...current, disabled: true })}>
          Remove from design
        </button>
        {Object.keys(current).length > 0 && (
          <button
            onClick={() => {
              setIds('');
              setParams('');
              setError(null);
              save({});
            }}
          >
            Reset overrides
          </button>
        )}
      </div>
      {children.length > 0 && (
        <div className="row">
          <span className="muted">Exclude management groups:</span>
          {children.map((c) => (
            <label key={c.role} className="check">
              <input type="checkbox" checked={excludedRoles.has(c.role)} onChange={(e) => toggleChild(c.role, e.target.checked)} />
              {c.displayName}
            </label>
          ))}
        </div>
      )}
      <label className="field">
        Exclude subscriptions or resource groups (one ID per line)
        <textarea rows={2} className="mono" value={ids} onChange={(e) => setIds(e.target.value)} onBlur={applyIds} placeholder="/subscriptions/<id>/resourceGroups/<name>" />
      </label>
      <label className="field">
        Parameter overrides (JSON)
        <textarea
          rows={3}
          className="mono"
          value={params}
          onChange={(e) => setParams(e.target.value)}
          onBlur={applyParams}
          placeholder={a.parameters ? JSON.stringify(a.parameters) : '{ "effect": "Audit" }'}
        />
      </label>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

let exemptionSeq = 0;

/** Exemptions of one assignment: the whole assignment or some of its policies, at a scope inside it. */
export function ExemptionsEditor(props: {
  catalog: Catalog;
  design: Design;
  mg: PlannedMg;
  assignment: PlannedAssignment;
  input: DesignInput;
  onChange: (input: DesignInput) => void;
}) {
  const { catalog, design, mg, assignment: a, input, onChange } = props;
  const scopes = descendants(design, mg);
  const [kind, setKind] = useState<ScopeRef['kind']>('managementGroup');
  const [role, setRole] = useState(mg.role);
  const [id, setId] = useState('');
  const [policies, setPolicies] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<Exemption['category']>('Waiver');
  const [reason, setReason] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mine = (input.exemptions ?? []).filter((e) => e.mg === mg.role && e.assignment === a.name);
  const remove = (eid: string) => onChange({ ...input, exemptions: input.exemptions.filter((e) => e.id !== eid) });
  const label = (e: Exemption) =>
    e.scope.kind === 'managementGroup' ? (design.mgs.find((m) => m.role === (e.scope as { role: string }).role)?.displayName ?? '') : e.scope.id;

  const add = () => {
    let scope: ScopeRef;
    if (kind === 'managementGroup') scope = { kind, role };
    else if (kind === 'subscription' && SUBSCRIPTION.test(id.trim())) scope = { kind, id: id.trim().replace(/^\/subscriptions\//i, '') };
    else if (kind === 'resourceGroup' && RESOURCE_GROUP.test(id.trim())) scope = { kind, id: id.trim() };
    else return setError(kind === 'subscription' ? 'Enter a subscription ID.' : 'Enter /subscriptions/<id>/resourceGroups/<name>.');
    if (!reason.trim()) return setError('Give a reason: it becomes the exemption description.');
    setError(null);
    const exemption: Exemption = {
      id: `${Date.now().toString(36)}${(exemptionSeq++).toString(36)}`,
      mg: mg.role,
      assignment: a.name,
      scope,
      policies,
      category,
      reason: reason.trim(),
      ...(expiresOn ? { expiresOn } : {}),
    };
    onChange({ ...input, exemptions: [...(input.exemptions ?? []), exemption] });
    setPolicies([]);
    setReason('');
    setExpiresOn('');
  };

  const q = filter.trim().toLowerCase();
  const shown = a.policies.filter((m) => !q || (catalog.policies[m.p]?.n ?? m.p).toLowerCase().includes(q)).slice(0, 200);

  return (
    <div className="editor">
      <h4>Exemptions</h4>
      {mine.length > 0 && (
        <ul className="exemptions">
          {mine.map((e) => (
            <li key={e.id}>
              <span className="badge mode-dne">{e.category}</span> {e.policies.length ? `${e.policies.length} policies` : 'Whole assignment'} at{' '}
              <strong>{label(e)}</strong>
              {e.expiresOn && <span className="muted"> until {e.expiresOn}</span>}: {e.reason}{' '}
              <button className="link" onClick={() => remove(e.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <label>
          At
          <select value={kind} onChange={(e) => setKind(e.target.value as ScopeRef['kind'])}>
            <option value="managementGroup">Management group</option>
            <option value="subscription">Subscription</option>
            <option value="resourceGroup">Resource group</option>
          </select>
        </label>
        {kind === 'managementGroup' ? (
          <select value={role} onChange={(e) => setRole(e.target.value as PlannedMg['role'])}>
            {scopes.map((s) => (
              <option key={s.role} value={s.role}>
                {s.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="mono scope-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={kind === 'subscription' ? 'subscription ID' : '/subscriptions/<id>/resourceGroups/<name>'}
          />
        )}
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as Exemption['category'])}>
            <option value="Waiver">Waiver</option>
            <option value="Mitigated">Mitigated</option>
          </select>
        </label>
        <label>
          Expires
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
      </div>
      <input className="wide" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />
      {a.kind === 'initiative' && (
        <details className="exempt-policies">
          <summary>{policies.length ? `${policies.length} of ${a.policies.length} policies` : `Whole assignment (or pick policies of ${a.policies.length})`}</summary>
          <input className="wide" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter policies" />
          <div className="policy-picks">
            {shown.map((m) => (
              <label key={m.p} className="check">
                <input
                  type="checkbox"
                  checked={policies.includes(m.p)}
                  onChange={(e) => setPolicies(e.target.checked ? [...policies, m.p] : policies.filter((p) => p !== m.p))}
                />
                {catalog.policies[m.p]?.n ?? m.p}
              </label>
            ))}
          </div>
        </details>
      )}
      <div className="row">
        <button onClick={add}>Add exemption</button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
