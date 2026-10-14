import { useEffect, useMemo, useState } from 'react';
import { Notes } from './components/common';
import { Coverage } from './components/Coverage';
import { Decisions } from './components/Decisions';
import { DesignsDialog } from './components/DesignsDialog';
import { ExportDialog } from './components/ExportDialog';
import { Hierarchy } from './components/Hierarchy';
import { Policies } from './components/Policies';
import { PrivilegedAccess } from './components/PrivilegedAccess';
import catalogJson from './data/catalog.json';
import type { Catalog } from './lib/catalog';
import {
  DEFAULT_EXPORT_SETTINGS,
  type SavedDesign,
  createDesign,
  duplicateDesign,
  hasUnsavedChanges,
  migrateExportSettings,
  migrateInput,
  renameDesign,
  updateDesign,
} from './lib/designs';
import { DEFAULT_INPUT, buildDesign, type DesignInput } from './lib/engine';
import type { ExportSettings } from './lib/iac';
import { STORAGE_KEYS, loadDesigns, loadExportSettings, loadInput, readJson, saveInput, writeJson } from './lib/storage';
import { downloadFile } from './lib/download';
import { buildReport, reportFileName } from './lib/report';
import { createXlsx } from './lib/xlsx';

const catalog = catalogJson as unknown as Catalog;

type View = 'hierarchy' | 'coverage' | 'policies' | 'pim';

const VIEWS: { value: View; label: string }[] = [
  { value: 'hierarchy', label: 'Management groups' },
  { value: 'coverage', label: 'Control coverage' },
  { value: 'policies', label: 'Policies' },
  { value: 'pim', label: 'Privileged access' },
];

export default function App() {
  const [input, setInput] = useState<DesignInput>(loadInput);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(loadExportSettings);
  const [view, setView] = useState<View>(() => readJson<View>(STORAGE_KEYS.view) ?? 'hierarchy');
  const [storageOk, setStorageOk] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showDesigns, setShowDesigns] = useState(false);
  const design = useMemo(() => buildDesign(catalog, input), [input]);
  const warnings = design.notes.filter((n) => n.level === 'warning').length;

  // Saved designs, and the one the current decisions belong to (if any).
  const [designs, setDesigns] = useState<SavedDesign[]>(loadDesigns);
  const [activeDesignId, setActiveDesignId] = useState<string | null>(() => readJson<string>(STORAGE_KEYS.activeDesign));
  const activeDesign = designs.find((d) => d.id === activeDesignId);
  const unsaved = hasUnsavedChanges(activeDesign, input, exportSettings);

  useEffect(() => {
    setStorageOk(saveInput(input));
  }, [input]);
  useEffect(() => {
    writeJson(STORAGE_KEYS.export, exportSettings);
  }, [exportSettings]);
  useEffect(() => {
    setStorageOk(writeJson(STORAGE_KEYS.designs, designs));
  }, [designs]);
  useEffect(() => {
    writeJson(STORAGE_KEYS.activeDesign, activeDesign ? activeDesign.id : null);
  }, [activeDesign]);
  useEffect(() => {
    writeJson(STORAGE_KEYS.view, view);
  }, [view]);

  /** Save into the open design, or as a new one if none is open. */
  const saveDesign = (asNew = false) => {
    if (activeDesign && !asNew) {
      setDesigns(designs.map((d) => (d.id === activeDesign.id ? updateDesign(d, input, exportSettings) : d)));
    } else {
      const saved = asNew && activeDesign ? duplicateDesign(createDesign(input, exportSettings), designs) : createDesign(input, exportSettings);
      setDesigns([...designs, saved]);
      setActiveDesignId(saved.id);
      if (saved.name !== input.name) setInput({ ...input, name: saved.name });
    }
  };

  const openDesign = (id: string) => {
    const saved = designs.find((d) => d.id === id);
    if (!saved) return;
    setInput(migrateInput(saved.input, saved.exportSettings as { excludeManualControls?: boolean }));
    setExportSettings(migrateExportSettings(saved.exportSettings));
    setActiveDesignId(id);
  };

  const newDesign = () => {
    setInput(DEFAULT_INPUT);
    setExportSettings(DEFAULT_EXPORT_SETTINGS);
    setActiveDesignId(null);
  };

  const renameSavedDesign = (id: string, name: string) => {
    setDesigns(designs.map((d) => (d.id === id ? renameDesign(d, name) : d)));
    // Keep the open design's name in step, so a rename alone isn't an unsaved change.
    if (id === activeDesignId) setInput({ ...input, name });
  };

  useEffect(() => {
    // Ctrl/Cmd+S saves the design instead of the web page.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveDesign();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reset = () => {
    if (window.confirm('Start a new design from the default NIST 800-53 example? Saved designs are kept.')) newDesign();
  };

  const { stats } = design;
  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <input
            className="design-title"
            aria-label="Design name"
            value={input.name}
            placeholder="Untitled design"
            onChange={(e) => setInput({ ...input, name: e.target.value })}
          />
          <span className="app-name">Azure Governance Planner</span>
          <button
            className={`chip save-chip ${activeDesign && !unsaved ? 'saved' : 'unsaved'}`}
            title={activeDesign ? 'Open Designs (Ctrl+S saves)' : 'This design is not saved yet. Open Designs to save it.'}
            onClick={() => setShowDesigns(true)}
          >
            {activeDesign ? (unsaved ? '● unsaved changes' : '✓ saved') : 'not saved'}
          </button>
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
          <button onClick={() => setShowDesigns(true)}>Designs{designs.length ? ` (${designs.length})` : ''}</button>
          <button
            title="Download the control coverage, assignments, exemptions, overrides and privileged access as an Excel workbook"
            onClick={() =>
              downloadFile(
                reportFileName(input),
                createXlsx(buildReport(catalog, design)),
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              )
            }
          >
            Compliance report
          </button>
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
          {!storageOk && <p className="muted">Browser storage is unavailable; designs won't be kept after you close the page. Export them from Designs.</p>}
          {view === 'hierarchy' && <Hierarchy catalog={catalog} design={design} input={input} onChange={setInput} />}
          {view === 'coverage' && <Coverage catalog={catalog} design={design} />}
          {view === 'policies' && <Policies catalog={catalog} design={design} />}
          {view === 'pim' && <PrivilegedAccess design={design} input={input} onChange={setInput} />}
          <footer className="muted">
            Policy data from the Azure Policy built-ins, the Azure Landing Zones library, AzAdvertizer and NIST OSCAL, snapshot{' '}
            {catalog.generated.slice(0, 10)}. Regenerate with <code>npm run update-catalog</code>.
          </footer>
        </main>
      </div>
      {exporting && (
        <ExportDialog
          catalog={catalog}
          design={design}
          settings={exportSettings}
          onSettingsChange={setExportSettings}
          excludeManualControls={input.excludeManualControls}
          onExcludeManualControlsChange={(excludeManualControls) => setInput({ ...input, excludeManualControls })}
          onClose={() => setExporting(false)}
        />
      )}
      {showDesigns && (
        <DesignsDialog
          catalog={catalog}
          input={input}
          exportSettings={exportSettings}
          designs={designs}
          activeId={activeDesign?.id ?? null}
          storageOk={storageOk}
          onSave={() => saveDesign()}
          onSaveAsNew={() => saveDesign(true)}
          onOpen={openDesign}
          onNew={newDesign}
          onRename={renameSavedDesign}
          onDuplicate={(id) => {
            const source = designs.find((d) => d.id === id);
            if (source) setDesigns([...designs, duplicateDesign(source, designs)]);
          }}
          onDelete={(id) => setDesigns(designs.filter((d) => d.id !== id))}
          onImport={(imported) => setDesigns([...designs, ...imported])}
          onClose={() => setShowDesigns(false)}
        />
      )}
    </div>
  );
}
