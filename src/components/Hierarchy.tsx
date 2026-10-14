import { type ReactNode, useState } from 'react';
import type { Catalog } from '../lib/catalog';
import {
  ENFORCING_EFFECTS,
  effectiveAssignments,
  exemptionExpiry,
  overrideKey,
  type Design,
  type DesignInput,
  type MgRole,
  type PlannedAssignment,
  type PlannedMg,
} from '../lib/engine';
import { ExemptionsEditor, OverrideEditor } from './AssignmentEditor';
import { EffectSummary, ModeBadge, OriginBadge, PolicyLink, definitionUrl } from './common';

const POLICY_PREVIEW = 40;

const isEnforcing = (a: PlannedAssignment) =>
  a.enforcementMode === 'Default' && a.policies.some((m) => ENFORCING_EFFECTS.has(m.e));

function depthOf(design: Design, mg: PlannedMg): number {
  let d = 0;
  for (let p = mg.parent; p; p = design.mgs.find((m) => m.role === p)?.parent ?? null) d++;
  return d;
}

function Tree(props: { design: Design; selected: MgRole; onSelect: (role: MgRole) => void }) {
  const { design } = props;
  return (
    <ol className="mg-tree">
      <li className="tenant">Tenant root group</li>
      {design.mgs.map((mg) => {
        const enforcing = mg.assignments.filter(isEnforcing).length;
        return (
          <li key={mg.role} style={{ paddingLeft: `${(depthOf(design, mg) + 1) * 20}px` }}>
            <button className={`mg-node mg-${mg.role} ${props.selected === mg.role ? 'active' : ''}`} onClick={() => props.onSelect(mg.role)}>
              <span className="mg-name">{mg.displayName}</span>
              <code>{mg.id}</code>
              <span className="mg-counts" title={`${mg.assignments.length} assignments here, ${enforcing} enforcing`}>
                {mg.assignments.length}
                {enforcing > 0 && <span className="enf"> · {enforcing} enforcing</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function AssignmentRow({
  catalog,
  assignment: a,
  inheritedFrom,
  inherited,
  onOpenParent,
  editors,
}: {
  catalog: Catalog;
  assignment: PlannedAssignment;
  /** The "From" column: where the assignment is made. */
  inheritedFrom?: string;
  /** Made at a parent, so read-only here. */
  inherited?: boolean;
  /** Open the parent the assignment is made at, to change it there. */
  onOpenParent?: () => void;
  /** Override and exemption editors, for assignments at the selected group. */
  editors?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const url = definitionUrl(a);
  const policies = all ? a.policies : a.policies.slice(0, POLICY_PREVIEW);
  return (
    <>
      <tr className={`assignment ${open ? 'open' : ''} ${inherited ? 'inherited' : ''}`} onClick={() => setOpen(!open)}>
        <td>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <code>{a.name}</code>
        </td>
        <td>
          {a.displayName}
          {a.change && <span className="changed" title={a.change}> ●</span>}
          {a.overridden && <span className="badge origin-enforcement">Overridden</span>}
          {a.exemptions.length > 0 && (
            <span className="badge mode-dne" title={a.exemptions.map((e) => e.reason).join('\n')}>
              {a.exemptions.length} exemption{a.exemptions.length > 1 ? 's' : ''}
            </span>
          )}
          {a.exemptions.some((e) => exemptionExpiry(e).state === 'expiring') && <span className="badge warn">expiring</span>}
        </td>
        <td>
          <OriginBadge origin={a.origin} />
        </td>
        <td>
          <ModeBadge assignment={a} />
        </td>
        <td className="num">{a.policies.length}</td>
        <td>
          <EffectSummary members={a.policies} />
        </td>
        {inheritedFrom !== undefined && (
          <td className="muted">
            {onOpenParent ? (
              <button
                className="link"
                title="Open this group to change or exempt the assignment"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenParent();
                }}
              >
                {inheritedFrom}
              </button>
            ) : (
              inheritedFrom
            )}
          </td>
        )}
      </tr>
      {open && (
        <tr className="assignment-detail">
          <td colSpan={inheritedFrom !== undefined ? 7 : 6}>
            <p>{a.description}</p>
            <p>
              <strong>Why:</strong> {a.rationale}
            </p>
            {a.change && (
              <p className="changed-text">
                <strong>Changed from ALZ:</strong> {a.change}
              </p>
            )}
            <p className="muted">
              {a.kind === 'initiative' ? 'Initiative' : 'Policy'} ·{' '}
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {a.definitionName}
                </a>
              ) : (
                <>{a.definitionName} (custom, created by this design)</>
              )}{' '}
              · {a.definitionSource}
              {a.identity && ' · needs a managed identity for remediation'}
            </p>
            {a.parameters && <pre className="code params">{JSON.stringify(a.parameters, null, 2)}</pre>}
            {editors}
            {inherited && onOpenParent && (
              <p className="muted">
                Inherited from {inheritedFrom}.{' '}
                <button className="link" onClick={onOpenParent}>
                  Open {inheritedFrom}
                </button>{' '}
                to override it, or exempt this group from it there.
              </p>
            )}
            <table className="members">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Category</th>
                  <th>Effect</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((m) => (
                  <tr key={m.p}>
                    <td>
                      <PolicyLink catalog={catalog} id={m.p} />
                    </td>
                    <td className="muted">{catalog.policies[m.p]?.c}</td>
                    <td>
                      <span className={`effect-${m.e}`}>{m.e}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!all && a.policies.length > POLICY_PREVIEW && (
              <button className="link more" onClick={() => setAll(true)}>
                Show all {a.policies.length} policies
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function Hierarchy({
  catalog,
  design,
  input,
  onChange,
}: {
  catalog: Catalog;
  design: Design;
  input: DesignInput;
  onChange: (input: DesignInput) => void;
}) {
  const [selected, setSelected] = useState<MgRole>('root');
  /** Which assignments to list: assigned at this group, inherited from its parents, or both. */
  const [scope, setScope] = useState<'here' | 'inherited' | 'all'>('here');
  /** Inherited from one parent in particular, or any. */
  const [from, setFrom] = useState<MgRole | 'any'>('any');
  const [query, setQuery] = useState('');
  const mg = design.mgs.find((m) => m.role === selected) ?? design.mgs[0];
  const inherited = effectiveAssignments(design, mg.role).filter((x) => x.mg.role !== mg.role);
  /** Every parent up to the top, nearest last (as effectiveAssignments orders them). */
  const parents: PlannedMg[] = [];
  for (let p = mg.parent; p; p = design.mgs.find((m) => m.role === p)?.parent ?? null) parents.unshift(design.mgs.find((m) => m.role === p)!);
  const enforcing = mg.assignments.filter(isEnforcing).length;
  const dne = mg.assignments.filter((a) => a.enforcementMode === 'DoNotEnforce').length;

  // A parent chosen for another group may not be above this one; the top group has no parents.
  const fromParent = from !== 'any' && parents.some((p) => p.role === from) ? from : 'any';
  const listScope = parents.length ? scope : 'here';
  const q = query.trim().toLowerCase();
  const matches = (a: PlannedAssignment) =>
    !q || a.name.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q) || a.definitionName.toLowerCase().includes(q);
  const own = listScope === 'inherited' ? [] : mg.assignments.filter(matches);
  const fromAbove =
    listScope === 'here' ? [] : inherited.filter((x) => (fromParent === 'any' || x.mg.role === fromParent) && matches(x.assignment));
  const showFrom = listScope !== 'here';
  const filtered = !!q || (showFrom && fromParent !== 'any');

  const select = (role: MgRole) => {
    setSelected(role);
    setQuery('');
  };

  return (
    <div className="hierarchy">
      <Tree design={design} selected={mg.role} onSelect={select} />
      <section className="card mg-detail">
        <header className="row">
          <h2>{mg.displayName}</h2>
          <code className="cidr">{mg.id}</code>
        </header>
        <p className="muted">{mg.description}</p>
        <p className="mg-summary">
          {mg.assignments.length} assignments here · {enforcing} enforcing · {dne} in DoNotEnforce · {inherited.length} inherited
        </p>

        <div className="row assignment-filter">
          {parents.length > 0 && (
            <div className="tabs" role="tablist" aria-label="Assignments to list">
              {(
                [
                  ['here', `Assigned here (${mg.assignments.length})`],
                  ['inherited', `Inherited (${inherited.length})`],
                  ['all', `All effective (${mg.assignments.length + inherited.length})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={listScope === value}
                  className={listScope === value ? 'active' : ''}
                  onClick={() => setScope(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {showFrom && (
            <label>
              From
              <select value={fromParent} onChange={(e) => setFrom(e.target.value as MgRole | 'any')}>
                <option value="any">Any parent</option>
                {parents.map((p) => (
                  <option key={p.role} value={p.role}>
                    {p.displayName} ({inherited.filter((x) => x.mg.role === p.role).length})
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            className="filter-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name"
            aria-label="Filter assignments by name"
          />
          {filtered && <span className="muted">{own.length + fromAbove.length} shown</span>}
        </div>

        {own.length + fromAbove.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Definition</th>
                  <th>Origin</th>
                  <th>Mode</th>
                  <th className="num">Policies</th>
                  <th>Effect</th>
                  {showFrom && <th>From</th>}
                </tr>
              </thead>
              <tbody>
                {own.map((a) => (
                  <AssignmentRow
                    key={a.name}
                    catalog={catalog}
                    assignment={a}
                    inheritedFrom={showFrom ? 'This group' : undefined}
                    editors={
                      <>
                        <OverrideEditor key={`o-${mg.role}-${a.name}`} design={design} mg={mg} assignment={a} input={input} onChange={onChange} />
                        <ExemptionsEditor catalog={catalog} design={design} mg={mg} assignment={a} input={input} onChange={onChange} />
                      </>
                    }
                  />
                ))}
                {fromAbove.map(({ mg: parent, assignment }) => (
                  <AssignmentRow
                    key={`${parent.role}/${assignment.name}`}
                    catalog={catalog}
                    assignment={assignment}
                    inheritedFrom={parent.displayName}
                    inherited
                    onOpenParent={() => select(parent.role)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            {filtered
              ? 'No assignments match the filter.'
              : listScope === 'inherited'
                ? 'Nothing is inherited here.'
                : 'No assignments at this level; everything here is inherited.'}
          </p>
        )}
        {mg.removed.length > 0 && (
          <p className="removed">
            Removed by override:{' '}
            {mg.removed.map((name) => (
              <span key={name} className="removed-item">
                <code>{name}</code>{' '}
                <button
                  className="link"
                  onClick={() => {
                    const overrides = { ...input.overrides };
                    const { disabled: _, ...rest } = overrides[overrideKey(mg.role, name)] ?? {};
                    if (Object.keys(rest).length) overrides[overrideKey(mg.role, name)] = rest;
                    else delete overrides[overrideKey(mg.role, name)];
                    onChange({ ...input, overrides });
                  }}
                >
                  Restore
                </button>
              </span>
            ))}
          </p>
        )}
      </section>
    </div>
  );
}
