import { useMemo, useState } from 'react';
import type { Catalog } from '../lib/catalog';
import { ENFORCING_EFFECTS, type Design, type PolicyRow } from '../lib/engine';
import { controlLabel } from '../lib/families';
import { PolicyLink } from './common';

type Filter = 'framework' | 'enforced' | 'not-enforced' | 'all';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'framework', label: 'Mapped to a selected framework' },
  { value: 'not-enforced', label: 'Framework policies only audited' },
  { value: 'enforced', label: 'Enforced anywhere' },
  { value: 'all', label: 'Every policy in the design' },
];

const PAGE = 200;

const enforced = (r: PolicyRow) => r.placements.some((p) => p.enforced && ENFORCING_EFFECTS.has(p.effect));

export function Policies({ catalog, design }: { catalog: Catalog; design: Design }) {
  const [chosen, setFilter] = useState<Filter>('framework');
  // Framework filters show nothing once every framework is deselected.
  const filter: Filter = design.coverage.length || chosen === 'enforced' ? chosen : 'all';
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const mgName = new Map(design.mgs.map((m) => [m.role, m.displayName]));
  const shortOf = new Map(design.coverage.map((c) => [c.key, c.short]));

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return design.policies
      .filter((r) => {
        if (filter === 'framework' && !r.frameworks.length) return false;
        if (filter === 'enforced' && !enforced(r)) return false;
        if (filter === 'not-enforced' && (!r.frameworks.length || enforced(r))) return false;
        if (!q) return true;
        const p = catalog.policies[r.id];
        return (
          r.id.includes(q) ||
          p?.n.toLowerCase().includes(q) ||
          p?.c.toLowerCase().includes(q) ||
          r.frameworks.some((f) => f.controls.some((c) => c.toLowerCase().includes(q)))
        );
      })
      .sort((a, b) => b.frameworks.length - a.frameworks.length || (catalog.policies[a.id]?.n ?? '').localeCompare(catalog.policies[b.id]?.n ?? ''));
  }, [catalog, design, filter, query]);

  return (
    <section className="card policies">
      <header className="row">
        <h2>Policies</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input className="search" placeholder="Search name, category or control" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="muted">{rows.length.toLocaleString()} policies</span>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Policy</th>
              <th>Category</th>
              <th>Controls</th>
              <th>Assigned</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => {
              const p = catalog.policies[r.id];
              return (
                <tr key={r.id}>
                  <td>
                    <PolicyLink catalog={catalog} id={r.id} />
                    {p?.pv && <span className="badge warn">preview</span>}
                    {p?.dp && <span className="badge warn">deprecated</span>}
                  </td>
                  <td className="muted">{p?.c}</td>
                  <td className="controls">
                    {r.frameworks.map((f) => (
                      <div key={f.key} title={f.controls.join(', ')}>
                        <strong>{shortOf.get(f.key)}</strong>{' '}
                        {f.controls
                          .slice(0, 6)
                          .map((c) => controlLabel(f.key, c))
                          .join(', ')}
                        {f.controls.length > 6 && <span className="muted"> +{f.controls.length - 6}</span>}
                      </div>
                    ))}
                  </td>
                  <td className="placements">
                    {r.placements.map((pl, i) => (
                      <div key={i} className={pl.enforced && ENFORCING_EFFECTS.has(pl.effect) ? 'enforcing' : ''}>
                        <span className={`effect-${pl.effect}`}>{pl.effect || 'Default'}</span>
                        {!pl.enforced && <span className="muted"> (DoNotEnforce)</span>} at {mgName.get(pl.mg)}{' '}
                        <code className="muted">{pl.assignment}</code>
                      </div>
                    ))}
                    {!r.placements.length && <span className="muted">not assigned</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button className="link more" onClick={() => setLimit(limit + PAGE)}>
          Show {Math.min(PAGE, rows.length - limit)} more
        </button>
      )}
    </section>
  );
}
