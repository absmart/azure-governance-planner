import { useState } from 'react';
import type { Catalog } from '../lib/catalog';
import type { ControlStatus, Design, FamilyCoverage, FrameworkCoverage } from '../lib/engine';
import { controlLabel } from '../lib/families';
import { PolicyLink, STATUSES, STATUS_HELP, STATUS_LABEL, StatusBar, StatusChip } from './common';

function Family({ catalog, fw, family, filter }: { catalog: Catalog; fw: FrameworkCoverage; family: FamilyCoverage; filter: ControlStatus | null }) {
  const [open, setOpen] = useState(false);
  const [openControl, setOpenControl] = useState<string | null>(null);
  const controls = filter ? family.controls.filter((c) => c.status === filter) : family.controls;
  if (filter && !controls.length) return null;
  return (
    <>
      <tr className={`family ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
        <td>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <code>{family.code}</code>
        </td>
        <td>{family.title}</td>
        <td className="num">{family.controls.length}</td>
        {STATUSES.map((s) => (
          <td key={s} className={`num ${family.counts[s] ? `txt-${s}` : 'muted'}`}>
            {family.counts[s]}
          </td>
        ))}
        <td className="bar-cell">
          <StatusBar counts={family.counts} />
        </td>
      </tr>
      {open &&
        controls.map((c) => (
          <tr key={c.id} className="control" onClick={() => setOpenControl(openControl === c.id ? null : c.id)}>
            <td className="control-id">
              <code>{controlLabel(fw.key, c.id)}</code>
            </td>
            <td colSpan={STATUSES.length + 2}>
              {c.title && <span>{c.title} </span>}
              <span className="muted">
                {c.automated.length} automated · {c.manual} manual
                {c.enforcedBy.length > 0 && <> · enforced by {c.enforcedBy.join(', ')}</>}
                {c.pim && c.status !== 'pim' && <> · also addressed by PIM</>}
              </span>
              {c.exceptions.length > 0 && (
                <div className="exceptions" title={c.exceptions.join('\n')}>
                  <span className="badge warn">partly</span> {c.exceptions.join('; ')}
                </div>
              )}
              {openControl === c.id && c.automated.length > 0 && (
                <ul className="control-policies">
                  {c.automated.map((p) => (
                    <li key={p}>
                      <PolicyLink catalog={catalog} id={p} />
                    </li>
                  ))}
                </ul>
              )}
            </td>
            <td>
              <StatusChip status={c.status} />
            </td>
          </tr>
        ))}
    </>
  );
}

export function Coverage({ catalog, design }: { catalog: Catalog; design: Design }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<ControlStatus | null>(null);
  if (!design.coverage.length) return <p className="card muted">Select a framework to see how the design covers its controls.</p>;
  const fw = design.coverage.find((c) => c.key === selected) ?? design.coverage[0];
  const scopeName = design.mgs.find((m) => m.role === fw.scope)?.displayName ?? fw.scope;
  const pct = (n: number) => (fw.inScope ? Math.round((n / fw.inScope) * 100) : 0);

  return (
    <div className="coverage">
      {design.coverage.length > 1 && (
        <nav className="fw-tabs">
          {design.coverage.map((c) => (
            <button key={c.key} className={c.key === fw.key ? 'active' : ''} onClick={() => setSelected(c.key)}>
              {c.short}
              <StatusBar counts={c.counts} />
            </button>
          ))}
        </nav>
      )}
      <section className="card">
        <header className="row">
          <h2>{fw.name}</h2>
          <span className="muted">v{fw.framework.version}</span>
        </header>
        <p className="muted">
          Assigned at {scopeName} · {fw.automatedPolicies} automated and {fw.manualPolicies} manual policies ·{' '}
          {fw.inScope} controls in scope
          {fw.outOfBaseline > 0 && <> ({fw.outOfBaseline} outside the selected baseline)</>}
          {fw.partial > 0 && (
            <>
              {' '}
              · <span className="partial-count">{fw.partial} only partly applied</span> (excluded scopes or exemptions)
            </>
          )}
        </p>
        <StatusBar counts={fw.counts} />
        <div className="legend">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`legend-item ${filter === s ? 'active' : ''}`}
              title={`${STATUS_HELP[s]} Click to filter.`}
              onClick={() => setFilter(filter === s ? null : s)}
            >
              <span className={`dot st-${s}`} />
              {STATUS_LABEL[s]} <strong>{fw.counts[s]}</strong> <span className="muted">{pct(fw.counts[s])}%</span>
            </button>
          ))}
        </div>
        <p className="muted">
          Azure Policy can only evaluate resource configuration. Manual and unmapped controls need process evidence;
          Defender for Cloud's regulatory compliance dashboard tracks them.
        </p>
        <div className="table-scroll">
          <table className="families">
            <thead>
              <tr>
                <th>Family</th>
                <th>Title</th>
                <th className="num">Controls</th>
                {STATUSES.map((s) => (
                  <th key={s} className="num">
                    {STATUS_LABEL[s]}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {fw.families.map((family) => (
                <Family key={`${fw.key}/${family.code}`} catalog={catalog} fw={fw} family={family} filter={filter} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
