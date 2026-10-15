import { useEffect, useMemo, useRef, useState } from 'react';
import { Notes } from './components/common';
import { CompareView } from './components/CompareView';
import { CostView } from './components/CostView';
import { Coverage } from './components/Coverage';
import { Decisions } from './components/Decisions';
import { DesignChangesNotice } from './components/DesignChangesNotice';
import { DesignsDialog } from './components/DesignsDialog';
import { ExportDialog } from './components/ExportDialog';
import { Hierarchy } from './components/Hierarchy';
import { Policies } from './components/Policies';
import { PrivilegedAccess } from './components/PrivilegedAccess';
import { ShareDialog } from './components/ShareDialog';
import catalogJson from './data/catalog.json';
import { designBaseline, designChanges, type DesignChanges } from './lib/baseline';
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
import { DEFAULT_INPUT, buildDesign, withCustomPolicies, type Design, type DesignInput } from './lib/engine';
import type { ExportSettings, MigrationExport } from './lib/iac';
import type { PolicySnapshot } from './lib/snapshot';
import { decodeDesign, tokenFromHash } from './lib/share';
import { STORAGE_KEYS, loadDesigns, loadExportSettings, loadInput, readJson, saveInput, writeJson } from './lib/storage';
import { downloadFile } from './lib/download';
import { estimateCost, formatUsd } from './lib/cost';
import { buildReport, reportFileName } from './lib/report';
import { createXlsx } from './lib/xlsx';

const baseCatalog = catalogJson as unknown as Catalog;

type View = 'hierarchy' | 'coverage' | 'policies' | 'pim' | 'cost' | 'compare';

const VIEWS: { value: View; label: string }[] = [
  { value: 'hierarchy', label: 'Management groups' },
  { value: 'coverage', label: 'Control coverage' },
  { value: 'policies', label: 'Policies' },
  { value: 'pim', label: 'Privileged access' },
  { value: 'cost', label: 'Cost' },
  { value: 'compare', label: 'Compare' },
];

export default function App() {
  const [input, setInput] = useState<DesignInput>(loadInput);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(loadExportSettings);
  const [view, setView] = useState<View>(() => readJson<View>(STORAGE_KEYS.view) ?? 'hierarchy');
  const [storageOk, setStorageOk] = useState(true);
  const [exporting, setExporting] = useState(false);
  /** A migration phase being exported (from Compare). */
  const [migrationExport, setMigrationExport] = useState<{ design: Design; migration: MigrationExport & { title: string } } | null>(null);
  const [showDesigns, setShowDesigns] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** A shared design link that couldn't be opened, or the one just opened. */
  const [shareMessage, setShareMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [azureImports, setAzureImports] = useState<PolicySnapshot[]>(() => readJson<PolicySnapshot[]>(STORAGE_KEYS.azureImports) ?? []);
  useEffect(() => {
    setStorageOk(writeJson(STORAGE_KEYS.azureImports, azureImports));
  }, [azureImports]);
  // Policies custom assignments brought from the policy index join the catalog.
  const catalog = useMemo(() => withCustomPolicies(baseCatalog, input.customAssignments), [input.customAssignments]);
  const design = useMemo(() => buildDesign(catalog, input), [catalog, input]);
  const warnings = design.notes.filter((n) => n.level === 'warning').length;
  const monthlyCost = useMemo(() => estimateCost(input).monthly, [input]);

  // Saved designs, and the one the current decisions belong to (if any).
  const [designs, setDesigns] = useState<SavedDesign[]>(loadDesigns);
  const [activeDesignId, setActiveDesignId] = useState<string | null>(() => readJson<string>(STORAGE_KEYS.activeDesign));
  const activeDesign = designs.find((d) => d.id === activeDesignId);
  /** A reopened design that deploys differently from when it was saved. */
  const [openedChanges, setOpenedChanges] = useState<{ id: string; name: string; changes: DesignChanges } | null>(null);
  /** What each saved design deploys, built from its decisions. */
  const buildSaved = (d: SavedDesign) => buildDesign(baseCatalog, migrateInput(d.input, d.exportSettings as { excludeManualControls?: boolean }));
  // Designs saved before baselines existed get one now: changes are tracked from here.
  useEffect(() => {
    if (designs.some((d) => !d.baseline)) setDesigns(designs.map((d) => (d.baseline ? d : { ...d, baseline: designBaseline(baseCatalog, buildSaved(d)) })));
  }, [designs]);
  /** Saved designs that deploy differently now, for the designs list. */
  const changedDesigns = useMemo(() => {
    const out: Record<string, DesignChanges> = {};
    for (const d of designs) {
      if (!d.baseline) continue;
      const c = designChanges(d.baseline, baseCatalog, buildSaved(d));
      if (c) out[d.id] = c;
    }
    return out;
  }, [designs]);
  const unsaved = hasUnsavedChanges(activeDesign, input, exportSettings);
  // For the design-link handler, which only runs once: whether there's work a link would replace.
  const unsavedRef = useRef(false);
  unsavedRef.current = unsaved && JSON.stringify(input) !== JSON.stringify(DEFAULT_INPUT);

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
      setDesigns(designs.map((d) => (d.id === activeDesign.id ? { ...updateDesign(d, input, exportSettings), baseline: designBaseline(catalog, design) } : d)));
      setOpenedChanges(null);
    } else {
      const created = asNew && activeDesign ? duplicateDesign(createDesign(input, exportSettings), designs) : createDesign(input, exportSettings);
      const saved = { ...created, baseline: designBaseline(catalog, design) };
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
    const changes = changedDesigns[id];
    setOpenedChanges(changes ? { id, name: saved.name, changes } : null);
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

  // A design link (#design=...) opens the design it carries as the current, unsaved one.
  useEffect(() => {
    const open = async () => {
      const token = tokenFromHash(window.location.hash);
      if (!token) return;
      // A reload shouldn't open it again.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      try {
        const shared = await decodeDesign(token);
        if (unsavedRef.current && !window.confirm(`Open the shared design "${shared.input.name}"? The current design has unsaved changes, which will be lost.`)) return;
        setInput(shared.input);
        if (shared.exportSettings) setExportSettings(shared.exportSettings);
        setActiveDesignId(null);
        setShareMessage({ kind: 'ok', text: `Opened the shared design "${shared.input.name}". Save it from Designs to keep it.` });
      } catch (e) {
        setShareMessage({ kind: 'error', text: `Couldn't open the design link: ${(e as Error).message}` });
      }
    };
    void open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  /** The most recent Azure import with compliance state, for the report. */
  const latestCompliance = [...azureImports].reverse().find((s) => s.compliance);
  const downloadReport = (azure?: PolicySnapshot) =>
    downloadFile(reportFileName(input), createXlsx(buildReport(catalog, design, new Date(), azure)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

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
          <button title="A link that carries this design, to send to someone" onClick={() => setSharing(true)}>
            Share
          </button>
          <button
            title={`Download the control coverage, assignments, exemptions, overrides and privileged access as an Excel workbook${
              latestCompliance ? `, with the compliance in Azure from "${latestCompliance.label}"` : ''
            }`}
            onClick={() => downloadReport(latestCompliance)}
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
          <span title="Rough monthly running cost of the decisions; see the Cost view">
            ≈ <strong>{formatUsd(monthlyCost)}</strong>/month
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
          {shareMessage && (
            <ul className="issues">
              <li className={shareMessage.kind}>
                {shareMessage.text}{' '}
                <button className="link" onClick={() => setShareMessage(null)}>
                  Dismiss
                </button>
              </li>
            </ul>
          )}
          {openedChanges && openedChanges.id === activeDesignId && (
            <DesignChangesNotice
              catalog={catalog}
              name={openedChanges.name}
              changes={openedChanges.changes}
              onReviewed={() => {
                const saved = designs.find((d) => d.id === openedChanges.id);
                if (saved) setDesigns(designs.map((d) => (d.id === saved.id ? { ...d, baseline: designBaseline(baseCatalog, buildSaved(saved)) } : d)));
                setOpenedChanges(null);
              }}
              onDismiss={() => setOpenedChanges(null)}
            />
          )}
          <Notes notes={design.notes} />
          {!storageOk && <p className="muted">Browser storage is unavailable; designs won't be kept after you close the page. Export them from Designs.</p>}
          {view === 'hierarchy' && <Hierarchy catalog={catalog} design={design} input={input} onChange={setInput} />}
          {view === 'coverage' && <Coverage catalog={catalog} design={design} />}
          {view === 'policies' && <Policies catalog={catalog} design={design} />}
          {view === 'pim' && <PrivilegedAccess design={design} input={input} onChange={setInput} />}
          {view === 'cost' && <CostView input={input} onChange={setInput} />}
          {view === 'compare' && (
            <CompareView
              catalog={catalog}
              design={design}
              input={input}
              designs={designs}
              imports={azureImports}
              onImportsChange={setAzureImports}
              onExportMigration={(d, migration) => setMigrationExport({ design: d, migration })}
              onUsePrefix={(prefix) => setInput({ ...input, prefix })}
              onReport={downloadReport}
            />
          )}
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
      {migrationExport && (
        <ExportDialog
          catalog={catalog}
          design={migrationExport.design}
          settings={exportSettings}
          onSettingsChange={setExportSettings}
          excludeManualControls={input.excludeManualControls}
          onExcludeManualControlsChange={(excludeManualControls) => setInput({ ...input, excludeManualControls })}
          migration={migrationExport.migration}
          onClose={() => setMigrationExport(null)}
        />
      )}
      {sharing && <ShareDialog input={input} exportSettings={exportSettings} onClose={() => setSharing(false)} />}
      {showDesigns && (
        <DesignsDialog
          catalog={catalog}
          input={input}
          exportSettings={exportSettings}
          designs={designs}
          changed={changedDesigns}
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
