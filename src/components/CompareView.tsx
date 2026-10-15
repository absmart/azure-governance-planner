import { useMemo, useState } from 'react';
import type { Catalog } from '../lib/catalog';
import {
  compareAssignments,
  compareMgs,
  comparePolicies,
  coverageDifferences,
  overlap,
  snapshotCoverage,
  type ControlComplianceState,
  type PolicyComparison,
  type SnapshotControlStatus,
  type SnapshotCoverage,
} from '../lib/compare';
import { migrateInput, type SavedDesign } from '../lib/designs';
import { buildDesign, type Design, type DesignInput } from '../lib/engine';
import { catalogPolicy, designSnapshot, policyLabel, type PolicySnapshot } from '../lib/snapshot';
import type { MigrationExport } from '../lib/iac';
import { buildMigrationPlan } from '../lib/migration';
import { ImportAzureDialog } from './ImportAzureDialog';
import { MigrationPlan } from './MigrationPlan';
import { PolicyLink } from './common';

type Side = 'a' | 'b' | 'both';
const PAGE = 200;

const STATUS_LABEL: Record<SnapshotControlStatus, string> = {
  enforced: 'Enforced',
  audited: 'Audited',
  manual: 'Manual only',
  missing: 'Not assigned',
  none: 'No policy',
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const COMPLIANCE_LABEL: Record<ControlComplianceState, string> = {
  noncompliant: 'Non-compliant',
  compliant: 'Compliant',
  notEvaluated: 'Not evaluated',
};

/** How compliant an imported tenant is, per control of the framework. */
function ComplianceSummary(props: { catalog: Catalog; label: string; coverage: SnapshotCoverage }) {
  const { catalog, label, coverage } = props;
  const [all, setAll] = useState(false);
  const c = coverage.compliance!;
  const failing = [...c.controls].filter(([, x]) => x.state === 'noncompliant').sort((x, y) => y[1].nonCompliant - x[1].nonCompliant);
  const shown = all ? failing : failing.slice(0, 25);
  return (
    <>
      <h3 className="section-label">Compliance in Azure: {label}</h3>
      <p className="muted">
        From the last policy evaluation, for the {coverage.short} controls with automated policies. A control is non-compliant when any
        resource fails one of its assigned policies.
      </p>
      <p className="compliance-counts">
        {(Object.keys(COMPLIANCE_LABEL) as ControlComplianceState[]).map((s) => (
          <span key={s} className={`chip compliance-${s}`}>
            {COMPLIANCE_LABEL[s]}: <strong>{c.counts[s]}</strong>
          </span>
        ))}
      </p>
      {failing.length > 0 && (
        <div className="table-scroll diff-list">
          <table>
            <thead>
              <tr>
                <th>Control</th>
                <th className="num">Non-compliant resources</th>
                <th>Failing policies</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(([id, x]) => (
                <tr key={id}>
                  <td>
                    <code>{id}</code> <span className="muted">{catalog.nist.controls[id]?.t}</span>
                  </td>
                  <td className="num compliance-noncompliant">{x.nonCompliant.toLocaleString()}</td>
                  <td>
                    {x.failing.slice(0, 3).map((f, i) => (
                      <span key={f.p}>
                        {i > 0 && '; '}
                        {GUID.test(f.p) ? <PolicyLink catalog={catalog} id={f.p} /> : policyLabel(catalog, f.p)}{' '}
                        <span className="muted">({f.nonCompliant})</span>
                      </span>
                    ))}
                    {x.failing.length > 3 && <span className="muted"> and {x.failing.length - 3} more</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failing.length > shown.length && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {failing.length}
        </button>
      )}
    </>
  );
}

/** Two overlapping circles with the policy counts; click a region to list it. */
function Venn(props: { a: string; b: string; counts: { onlyA: number; both: number; onlyB: number }; selected: Side; onSelect: (side: Side) => void }) {
  const { counts, selected } = props;
  const region = (side: Side, x: number, n: number, label: string) => (
    <g className={`venn-region ${selected === side ? 'selected' : ''}`} onClick={() => props.onSelect(side)} role="button" aria-label={`${label}: ${n}`}>
      <text x={x} y={108} textAnchor="middle" className="venn-count">
        {n.toLocaleString()}
      </text>
      <text x={x} y={128} textAnchor="middle" className="venn-label">
        {label}
      </text>
    </g>
  );
  return (
    <svg className="venn" viewBox="0 0 400 210" role="img" aria-label={`${props.a}: ${counts.onlyA} only, ${counts.both} in both, ${props.b}: ${counts.onlyB} only`}>
      <circle cx="150" cy="110" r="88" className={`venn-a ${selected === 'a' ? 'selected' : ''}`} onClick={() => props.onSelect('a')} />
      <circle cx="250" cy="110" r="88" className={`venn-b ${selected === 'b' ? 'selected' : ''}`} onClick={() => props.onSelect('b')} />
      <text x="110" y="14" textAnchor="middle" className="venn-title">
        A: {props.a.length > 26 ? `${props.a.slice(0, 25)}…` : props.a}
      </text>
      <text x="290" y="14" textAnchor="middle" className="venn-title">
        B: {props.b.length > 26 ? `${props.b.slice(0, 25)}…` : props.b}
      </text>
      {region('a', 112, counts.onlyA, 'only A')}
      {region('both', 200, counts.both, 'both')}
      {region('b', 288, counts.onlyB, 'only B')}
    </svg>
  );
}

function Placements({ list }: { list: PolicyComparison['a'] }) {
  if (!list.length) return <span className="muted">—</span>;
  return (
    <>
      {list.map((p, i) => (
        <div key={i} className={p.enforced ? 'enforcing' : ''}>
          <span className={`effect-${p.effect}`}>{p.effect}</span>
          {!p.enforced && p.effect !== 'unknown' && /deny|deploy|modify|append/i.test(p.effect) && <span className="muted"> (not enforced)</span>} at{' '}
          {p.scopeName} <code className="muted">{p.assignment}</code>
        </div>
      ))}
    </>
  );
}

/** Compare the current design, saved designs and Azure imports: overlapping policies, coverage, assignments and hierarchy. */
export function CompareView(props: {
  catalog: Catalog;
  design: Design;
  input: DesignInput;
  designs: SavedDesign[];
  imports: PolicySnapshot[];
  onImportsChange: (imports: PolicySnapshot[]) => void;
  /** Opens the export for a migration phase. */
  onExportMigration: (design: Design, migration: MigrationExport & { title: string }) => void;
  /** Sets the current design's prefix. */
  onUsePrefix: (prefix: string) => void;
}) {
  const { catalog, design, input, designs, imports } = props;
  const options = [
    { value: 'current', label: `Current design: ${input.name || 'Untitled'}` },
    ...designs.map((d) => ({ value: `design:${d.id}`, label: `Saved design: ${d.name}` })),
    ...imports.map((s, i) => ({ value: `azure:${i}`, label: `Azure import: ${s.label}` })),
  ];
  const [aKey, setA] = useState('current');
  const [bKey, setB] = useState(() => (imports.length ? `azure:${imports.length - 1}` : designs.length ? `design:${designs[0].id}` : 'current'));
  const [importing, setImporting] = useState(false);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [enforcedOnly, setEnforcedOnly] = useState(false);
  const [side, setSide] = useState<Side | 'differs'>('a');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [assignmentSide, setAssignmentSide] = useState<Side>('a');

  const snapshotOf = (key: string): PolicySnapshot | null => {
    if (key === 'current') return designSnapshot(design, input.name || 'Current design');
    if (key.startsWith('design:')) {
      const d = designs.find((x) => `design:${x.id}` === key);
      return d ? designSnapshot(buildDesign(catalog, migrateInput(d.input)), d.name) : null;
    }
    if (key.startsWith('azure:')) return imports[Number(key.slice(6))] ?? null;
    return null;
  };
  /** The design behind a side, when it is one. */
  const designOf = (key: string): { design: Design; label: string; current: boolean } | null => {
    if (key === 'current') return { design, label: input.name || 'Current design', current: true };
    const d = key.startsWith('design:') ? designs.find((x) => `design:${x.id}` === key) : undefined;
    return d ? { design: buildDesign(catalog, migrateInput(d.input)), label: d.name, current: false } : null;
  };
  const a = useMemo(() => snapshotOf(aKey), [aKey, design, designs, imports]);
  const b = useMemo(() => snapshotOf(bKey), [bKey, design, designs, imports]);

  const policies = useMemo(() => (a && b ? comparePolicies(a, b, { includeSystem }) : []), [a, b, includeSystem]);
  const counts = overlap(policies, enforcedOnly);
  const frameworks = [...new Set([...input.frameworks, ...(a?.frameworks ?? []), ...(b?.frameworks ?? [])])].filter((k) => catalog.frameworks.some((f) => f.key === k));
  const [frameworkKey, setFrameworkKey] = useState<string>('');
  const fw = frameworks.includes(frameworkKey) ? frameworkKey : frameworks[0];
  const nist = { baseline: input.nistBaseline, privacy: input.nistPrivacy };
  const covA = a && fw ? snapshotCoverage(catalog, a, fw, nist) : null;
  const covB = b && fw ? snapshotCoverage(catalog, b, fw, nist) : null;
  const diffs = covA && covB ? coverageDifferences(covA, covB) : [];
  const assignments = useMemo(() => (a && b ? compareAssignments(a, b, { includeSystem }) : []), [a, b, includeSystem]);
  const mgs = a && b ? compareMgs(a, b) : [];
  // A migration plan when one side is an Azure import and the other a design.
  const migration = useMemo(() => {
    const [azureKey, designKey] = aKey.startsWith('azure:') ? [aKey, bKey] : bKey.startsWith('azure:') ? [bKey, aKey] : [null, null];
    const current = azureKey ? imports[Number(azureKey.slice(6))] : undefined;
    const target = designKey ? designOf(designKey) : null;
    return current && target ? { target, plan: buildMigrationPlan(target.design, target.label, current) } : null;
  }, [aKey, bKey, design, designs, imports]);

  const inA = (r: PolicyComparison) => (enforcedOnly ? r.a.some((x) => x.enforced) : r.a.length > 0);
  const inB = (r: PolicyComparison) => (enforcedOnly ? r.b.some((x) => x.enforced) : r.b.length > 0);
  const q = query.trim().toLowerCase();
  const listed = policies
    .filter((r) =>
      side === 'differs' ? r.enforcementDiffers : side === 'both' ? inA(r) && inB(r) : side === 'a' ? inA(r) && !inB(r) : inB(r) && !inA(r),
    )
    .filter((r) => !q || policyLabel(catalog, r.p).toLowerCase().includes(q) || r.p.includes(q) || (catalogPolicy(catalog, r.p)?.c ?? '').toLowerCase().includes(q))
    .sort((x, y) => policyLabel(catalog, x.p).localeCompare(policyLabel(catalog, y.p)));

  const sideLabel = (s: Side) => (s === 'a' ? `Only in A` : s === 'b' ? `Only in B` : 'In both');
  const removeImport = (i: number) => {
    props.onImportsChange(imports.filter((_, j) => j !== i));
    if (aKey.startsWith('azure:')) setA('current');
    if (bKey.startsWith('azure:')) setB('current');
  };

  return (
    <div className="compare">
      <section className="card">
        <header className="row">
          <h2>Compare</h2>
          <button onClick={() => setImporting(true)}>Import from Azure…</button>
        </header>
        <p className="muted">
          Compare the current design with a saved design, or with what's actually deployed: import a tenant's policy assignments from
          Azure and see which policies overlap, how each side covers the frameworks, and which assignments and management groups differ.
        </p>
        <div className="compare-sides">
          {(
            [
              ['A', aKey, setA],
              ['B', bKey, setB],
            ] as const
          ).map(([name, value, set]) => (
            <label key={name} className="field">
              {name}
              <select value={value} onChange={(e) => set(e.target.value)}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} />
            Include Microsoft's hidden system assignments
          </label>
        </div>
        {imports.length > 0 && (
          <p className="muted imports">
            Azure imports:{' '}
            {imports.map((s, i) => (
              <span key={i} className="removed-item">
                {s.label} <span className="muted">({s.importedAt?.slice(0, 10)})</span>{' '}
                <button className="link" onClick={() => removeImport(i)}>
                  Remove
                </button>
              </span>
            ))}
          </p>
        )}
        {[a, b].flatMap((s) => (s?.notes ?? []).map((n) => `${s!.label}: ${n}`)).length > 0 && (
          <ul className="issues">
            {[a, b].flatMap((s) => (s?.notes ?? []).map((n) => <li key={`${s!.label}${n}`} className="info">{`${s!.label}: ${n}`}</li>))}
          </ul>
        )}
      </section>

      {a && b && (
        <>
          <section className="card">
            <header className="row">
              <h2>Policies in effect</h2>
              <div className="tabs">
                <button className={!enforcedOnly ? 'active' : ''} onClick={() => setEnforcedOnly(false)}>
                  All evaluated
                </button>
                <button className={enforcedOnly ? 'active' : ''} onClick={() => setEnforcedOnly(true)}>
                  Enforced
                </button>
              </div>
            </header>
            <p className="muted">
              {enforcedOnly
                ? 'Policies that block or remediate (Deny, DeployIfNotExists, Modify, Append) in an enforced assignment.'
                : 'Every policy an assignment evaluates (Disabled ones left out), wherever it is assigned.'}
            </p>
            <Venn a={a.label} b={b.label} counts={counts} selected={side === 'differs' ? 'both' : side} onSelect={(s) => { setSide(s); setLimit(PAGE); }} />
            <div className="row assignment-filter">
              <div className="tabs">
                {(['a', 'both', 'b'] as const).map((s) => (
                  <button key={s} className={side === s ? 'active' : ''} onClick={() => { setSide(s); setLimit(PAGE); }}>
                    {sideLabel(s)} ({(s === 'a' ? counts.onlyA : s === 'b' ? counts.onlyB : counts.both).toLocaleString()})
                  </button>
                ))}
                <button className={side === 'differs' ? 'active' : ''} onClick={() => { setSide('differs'); setLimit(PAGE); }}>
                  Enforcement differs ({policies.filter((r) => r.enforcementDiffers).length})
                </button>
              </div>
              <input className="filter-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or category" />
              <span className="muted">{listed.length.toLocaleString()} shown</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th>Category</th>
                    <th>A: {a.label}</th>
                    <th>B: {b.label}</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.slice(0, limit).map((r) => (
                    <tr key={r.p}>
                      <td>{catalogPolicy(catalog, r.p) ? <PolicyLink catalog={catalog} id={r.p} /> : <code>{r.p}</code>}</td>
                      <td className="muted">{catalogPolicy(catalog, r.p)?.c}</td>
                      <td className="placements">
                        <Placements list={r.a} />
                      </td>
                      <td className="placements">
                        <Placements list={r.b} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {listed.length > limit && (
              <button className="link more" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, listed.length - limit)} more
              </button>
            )}
          </section>

          {fw && covA && covB && (
            <section className="card">
              <header className="row">
                <h2>Framework coverage</h2>
                <select value={fw} onChange={(e) => setFrameworkKey(e.target.value)}>
                  {frameworks.map((k) => (
                    <option key={k} value={k}>
                      {catalog.frameworks.find((f) => f.key === k)?.short}
                    </option>
                  ))}
                </select>
              </header>
              <p className="muted">
                Each side rated by its policies alone{catalog.frameworks.find((f) => f.key === fw)?.nist ? `, for the ${input.nistBaseline} baseline` : ''}: "not
                assigned" means the framework has automated policies for the control but neither its initiative nor any of those policies is
                assigned.
              </p>
              <div className="table-scroll">
                <table className="compare-coverage">
                  <thead>
                    <tr>
                      <th />
                      {(Object.keys(STATUS_LABEL) as SnapshotControlStatus[]).map((s) => (
                        <th key={s} className="num">
                          {STATUS_LABEL[s]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ['A', a.label, covA],
                        ['B', b.label, covB],
                      ] as const
                    ).map(([name, label, c]) => (
                      <tr key={name}>
                        <td>
                          <strong>{name}</strong> {label}
                        </td>
                        {(Object.keys(STATUS_LABEL) as SnapshotControlStatus[]).map((s) => (
                          <td key={s} className={`num cmp-${s}`}>
                            {c.counts[s]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {[
                [a.label, covA],
                [b.label, covB],
              ].map(([label, c]) =>
                (c as SnapshotCoverage).compliance ? <ComplianceSummary key={label as string} catalog={catalog} label={label as string} coverage={c as SnapshotCoverage} /> : null,
              )}
              <h3 className="section-label">{diffs.length} controls rated differently</h3>
              {diffs.length > 0 && (
                <div className="table-scroll diff-list">
                  <table>
                    <thead>
                      <tr>
                        <th>Control</th>
                        <th>A</th>
                        <th>B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffs.slice(0, 300).map((d) => (
                        <tr key={d.control}>
                          <td>
                            <code>{d.control}</code> <span className="muted">{catalog.nist.controls[d.control]?.t}</span>
                          </td>
                          <td className={`cmp-${d.a}`}>{STATUS_LABEL[d.a]}</td>
                          <td className={`cmp-${d.b}`}>{STATUS_LABEL[d.b]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section className="card">
            <header className="row">
              <h2>Assignments</h2>
              <div className="tabs">
                {(['a', 'both', 'b'] as const).map((s) => (
                  <button key={s} className={assignmentSide === s ? 'active' : ''} onClick={() => setAssignmentSide(s)}>
                    {sideLabel(s)} ({assignments.filter((x) => x.side === s).length})
                  </button>
                ))}
              </div>
            </header>
            <p className="muted">Matched by definition (built-in ID, or custom name without an ALZ version suffix), wherever they are assigned.</p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Definition</th>
                    <th>A</th>
                    <th>B</th>
                    {assignmentSide === 'both' && <th>Differences</th>}
                  </tr>
                </thead>
                <tbody>
                  {assignments
                    .filter((x) => x.side === assignmentSide)
                    .map((x) => (
                      <tr key={x.definitionKey}>
                        <td>
                          {x.definitionName}
                          {[...x.a, ...x.b].some((y) => !y.membersKnown) && <span className="badge warn">policies unknown</span>}
                        </td>
                        {[x.a, x.b].map((list, i) => (
                          <td key={i} className="muted">
                            {list.map((y) => `${(i ? b : a).mgs.find((m) => m.id === y.scope)?.displayName ?? y.scope}${y.enforcementMode === 'DoNotEnforce' ? ' (DoNotEnforce)' : ''}`).join(', ') || '—'}
                          </td>
                        ))}
                        {assignmentSide === 'both' && <td className={x.differences.length ? 'differs' : 'muted'}>{x.differences.join('; ') || 'same'}</td>}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <header className="row">
              <h2>Management groups and scopes</h2>
            </header>
            <div className="mg-compare">
              {(['a', 'both', 'b'] as const).map((s) => (
                <div key={s}>
                  <h3 className="section-label">
                    {sideLabel(s)} ({mgs.filter((m) => m.side === s).length})
                  </h3>
                  <ul>
                    {mgs
                      .filter((m) => m.side === s)
                      .map((m) => (
                        <li key={m.id}>
                          {m.displayName} {m.displayName !== m.id && <code className="muted">{m.id}</code>}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {migration && (
        <MigrationPlan
          plan={migration.plan}
          design={migration.target.design}
          onExport={props.onExportMigration}
          onUsePrefix={migration.target.current ? props.onUsePrefix : undefined}
        />
      )}

      {importing && (
        <ImportAzureDialog
          catalog={catalog}
          onImport={(snapshot) => {
            props.onImportsChange([...imports, snapshot]);
            setB(`azure:${imports.length}`);
            setImporting(false);
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
