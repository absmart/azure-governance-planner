import { useEffect, useMemo, useState } from 'react';
import { Notes } from './components/common';
import { Coverage } from './components/Coverage';
import { Decisions } from './components/Decisions';
import { ExportDialog } from './components/ExportDialog';
import { Hierarchy } from './components/Hierarchy';
import { Policies } from './components/Policies';
import catalogJson from './data/catalog.json';
import type { Catalog } from './lib/catalog';
import { DEFAULT_INPUT, buildDesign, type DesignInput } from './lib/engine';
import { STORAGE_KEYS, loadInput, readJson, saveInput, writeJson } from './lib/storage';

const catalog = catalogJson as unknown as Catalog;

type View = 'hierarchy' | 'coverage' | 'policies';

const VIEWS: { value: View; label: string }[] = [
  { value: 'hierarchy', label: 'Management groups' },
  { value: 'coverage', label: 'Control coverage' },
  { value: 'policies', label: 'Policies' },
];

export default function App() {
  const [input, setInput] = useState<DesignInput>(loadInput);
  const [view, setView] = useState<View>(() => readJson<View>(STORAGE_KEYS.view) ?? 'hierarchy');
  const [storageOk, setStorageOk] = useState(true);
  const [exporting, setExporting] = useState(false);
  const design = useMemo(() => buildDesign(catalog, input), [input]);
  const warnings = design.notes.filter((n) => n.level === 'warning').length;

  useEffect(() => {
    setStorageOk(saveInput(input));
  }, [input]);
  useEffect(() => {
    writeJson(STORAGE_KEYS.view, view);
  }, [view]);

  const reset = () => {
    if (window.confirm('Reset every decision to the default NIST 800-53 example?')) setInput(DEFAULT_INPUT);
  };

  const { stats } = design;
  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <h1>Azure Governance Planner</h1>
          <div className="tabs">
            {VIEWS.map((v) => (
              <button key={v.value} className={view === v.value ? 'active' : ''} onClick={() => setView(v.value)}>
                {v.label}
              </button>
            ))}
          </div>
          <span className={`status ${warnings ? 'warning' : 'ok'}`}>
            {warnings} warning{warnings === 1 ? '' : 's'}
          </span>
          <button className="primary" onClick={() => setExporting(true)}>
            Export IaC
          </button>
          <button onClick={reset}>Reset</button>
        </div>
        <div className="stats">
          <span>
            <strong>{stats.managementGroups}</strong> management groups
          </span>
          <span>
            <strong>{stats.assignments}</strong> assignments
          </span>
          <span>
            <strong>{stats.enforcingAssignments}</strong> enforcing
          </span>
          <span>
            <strong>{stats.uniquePolicies.toLocaleString()}</strong> distinct policies
          </span>
          {design.coverage.map((c) => (
            <span key={c.key} title={`${c.short}: controls with at least one enforced policy`}>
              {c.short}: <strong>{c.counts.enforced + c.counts.audited}</strong>/{c.inScope} controls automated,{' '}
              <strong>{c.counts.enforced}</strong> enforced
            </span>
          ))}
        </div>
      </header>

      <div className="layout">
        <Decisions catalog={catalog} input={input} onChange={setInput} />
        <main>
          <Notes notes={design.notes} />
          {!storageOk && <p className="muted">Browser storage is unavailable; decisions won't be kept after you close the page.</p>}
          {view === 'hierarchy' && <Hierarchy catalog={catalog} design={design} input={input} onChange={setInput} />}
          {view === 'coverage' && <Coverage catalog={catalog} design={design} />}
          {view === 'policies' && <Policies catalog={catalog} design={design} />}
          <footer className="muted">
            Policy data from the Azure Policy built-ins, the Azure Landing Zones library, AzAdvertizer and NIST OSCAL, snapshot{' '}
            {catalog.generated.slice(0, 10)}. Regenerate with <code>npm run update-catalog</code>.
          </footer>
        </main>
      </div>
      {exporting && <ExportDialog catalog={catalog} design={design} onClose={() => setExporting(false)} />}
    </div>
  );
}
