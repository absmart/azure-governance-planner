import { useEffect, useMemo, useState } from 'react';
import type { Catalog } from '../lib/catalog';
import { downloadFile as save } from '../lib/download';
import type { Design } from '../lib/engine';
import {
  EXPORT_ROOT,
  FORMAT_LABEL,
  type AlzLibrary,
  type ExportSettings,
  type IacFormat,
  type MigrationExport,
  buildIacModel,
  generateIacFiles,
  manualPolicyCount,
  placeholderOf,
  platformSummary,
  roleAssignmentCount,
  unsetInputs,
} from '../lib/iac';
import { createZip } from '../lib/zip';

/** Longer files are cut short in the preview (they download in full). */
const PREVIEW_LIMIT = 60_000;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// The ALZ library is only needed here, so it is fetched on first export rather than bundled.
let libraryRequest: Promise<AlzLibrary> | null = null;
function loadLibrary(): Promise<AlzLibrary> {
  libraryRequest ??= fetch(`${import.meta.env.BASE_URL}alz-library.json`).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json() as Promise<AlzLibrary>;
  });
  libraryRequest.catch(() => (libraryRequest = null));
  return libraryRequest;
}

/** The design as Bicep, Terraform or Terragrunt, ready to copy or download. */
export function ExportDialog(props: {
  catalog: Catalog;
  design: Design;
  /** Format, environment and values; kept by the app so they're saved with the design. */
  settings: ExportSettings;
  onSettingsChange: (settings: ExportSettings) => void;
  /** The design's "Exclude manual-only controls", shown here too because it shapes the export. */
  excludeManualControls: boolean;
  onExcludeManualControlsChange: (exclude: boolean) => void;
  /** Exporting a migration phase: the plan, what exists in Azure, and a heading. */
  migration?: MigrationExport & { title: string };
  onClose: () => void;
}) {
  const { catalog, design, settings, onSettingsChange: setSettings, onClose } = props;
  const [library, setLibrary] = useState<AlzLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadLibrary().then(setLibrary, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const model = useMemo(() => (library ? buildIacModel(design, catalog, library) : null), [design, catalog, library]);
  const files = useMemo(() => (model ? generateIacFiles(settings.format, model, settings, props.migration) : []), [model, settings, props.migration]);
  const file = files[fileIndex] ?? files[0];
  const unset = model ? new Set(unsetInputs(model, settings).map((i) => i.name)) : new Set<string>();
  const root = EXPORT_ROOT[settings.format];

  const setValue = (name: string, value: string) => setSettings({ ...settings, values: { ...settings.values, [name]: value } });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const downloadZip = () =>
    save(`${root}.zip`, createZip(files.map((f) => ({ name: `${root}/${f.name}`, content: f.content }))), 'application/zip');

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Export IaC" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>{props.migration ? props.migration.title : 'Export infrastructure as code'}</h2>
          <div className="tabs">
            {(Object.keys(FORMAT_LABEL) as IacFormat[]).map((f) => (
              <button
                key={f}
                className={settings.format === f ? 'active' : ''}
                onClick={() => {
                  setSettings({ ...settings, format: f });
                  setFileIndex(0);
                }}
              >
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        {error && (
          <ul className="issues">
            <li className="warning">Couldn't load the ALZ library definitions ({error}). Check your connection and reopen the export.</li>
          </ul>
        )}
        {!model && !error && <p className="muted">Loading the ALZ library definitions…</p>}

        {model && (
          <div className="export-body">
            {props.migration && (
              <ul className="issues">
                <li className="info">
                  A migration phase: MIGRATION.md has the whole plan.{' '}
                  {settings.format === 'terraform'
                    ? `imports.tf adopts the ${props.migration.existing.managementGroups.length} management groups and ${props.migration.existing.assignments.length} assignments that already exist.`
                    : settings.format === 'terragrunt'
                      ? 'Terragrunt: the Terraform export has imports.tf to adopt what already exists; add its blocks to the module before the first apply.'
                      : 'Bicep updates what already exists in place.'}
                </li>
              </ul>
            )}
            <p className="muted">
              Creates the {model.managementGroups.length} management groups, {model.policyDefinitions.length} custom policy definitions
              and {model.policySetDefinitions.length} custom initiatives (ALZ library {model.alzRef}), all {model.assignments.length}{' '}
              assignments with their enforcement modes and parameters, and {roleAssignmentCount(model)} role assignments for the
              remediation identities.
              {platformSummary(model) && <> It also creates {platformSummary(model)}, and points the policies at them.</>}
              The template is generic; the design is data and this environment's values go in a small values file.
              {settings.format === 'terragrunt' && ' Terragrunt adds root.hcl for remote state and the provider.'}
            </p>

            <details className="inputs" open={unset.size > 0}>
              <summary>
                Environment values{' '}
                {unset.size > 0 ? (
                  <span className="badge warn">{unset.size} still placeholders</span>
                ) : (
                  <span className="badge mode-audit">all set</span>
                )}
              </summary>
              <p className="muted">
                Where the platform resources go, and the existing resources ALZ's DeployIfNotExists policies point at. Values at a
                placeholder deploy, but remediation fails until they're set.
              </p>
              <div className="input-grid">
                <label className="field">
                  Environment
                  <input
                    className="mono"
                    value={settings.environment}
                    onChange={(e) => setSettings({ ...settings, environment: e.target.value })}
                  />
                </label>
                {model.inputs.map((i) => (
                  <label key={i.name} className={`field ${unset.has(i.name) ? 'unset' : ''}`} title={`${i.description}\nUsed by ${i.usedBy.join(', ')}`}>
                    {i.name}
                    <input
                      className="mono"
                      value={settings.values[i.name] ?? ''}
                      placeholder={placeholderOf(i, model, settings)}
                      onChange={(e) => setValue(i.name, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </details>

            {manualPolicyCount(model).policies > 0 && !props.migration && (
              <label className="check placement" title="Assignment overrides set the manual-attestation policies to Disabled; up to 500 per assignment.">
                <input
                  type="checkbox"
                  checked={props.excludeManualControls}
                  onChange={(e) => props.onExcludeManualControlsChange(e.target.checked)}
                />
                Exclude manual-only controls: turn off the {manualPolicyCount(model).policies} manual-attestation policies in the
                framework initiatives, so controls only they cover aren't evaluated or listed as needing evidence
              </label>
            )}

            {model.subscriptionPlacements.length > 0 && (
              <label className="check placement">
                <input
                  type="checkbox"
                  checked={settings.placeSubscriptions !== false}
                  onChange={(e) => setSettings({ ...settings, placeSubscriptions: e.target.checked })}
                />
                Move {model.subscriptionPlacements.map((p) => p.input.replace(/_id$/, '').replace(/_/g, ' ')).join(' and ')} into{' '}
                {model.subscriptionPlacements.map((p) => p.managementGroupId).join(' and ')}, so the policy assignments apply to{' '}
                {model.subscriptionPlacements.length > 1 ? 'them' : 'it'}
              </label>
            )}

            {model.notes.length > 0 && (
              <ul className="issues">
                {model.notes.map((n, i) => (
                  <li key={i} className="info">
                    {n}
                  </li>
                ))}
              </ul>
            )}

            <div className="file-tabs" role="tablist">
              {files.map((f, i) => (
                <button key={f.name} role="tab" aria-selected={file === f} className={file === f ? 'active' : ''} onClick={() => setFileIndex(i)}>
                  {f.name}
                  <span className="muted">{f.description}</span>
                </button>
              ))}
            </div>
            <pre className="code export-code">
              {file.content.length > PREVIEW_LIMIT
                ? `${file.content.slice(0, PREVIEW_LIMIT)}\n… ${(file.content.length - PREVIEW_LIMIT).toLocaleString()} more characters in the download`
                : file.content}
            </pre>
            <div className="row footer">
              <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              <button onClick={() => save(baseName(file.name), file.content)}>Download {baseName(file.name)}</button>
              <button className="primary" onClick={downloadZip}>
                Download {root}.zip ({files.length} files)
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
