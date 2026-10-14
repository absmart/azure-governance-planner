import { useEffect, useMemo, useState } from 'react';
import type { Catalog } from '../lib/catalog';
import { AZURE_IMPORT_COMMANDS, AZURE_IMPORT_QUERIES, parseAzureImport, type PolicySnapshot } from '../lib/snapshot';

/** The import methods: the two commands, then Resource Graph Explorer in the portal. */
const METHODS = [...AZURE_IMPORT_COMMANDS.map((c) => c.label), 'Resource Graph Explorer (portal)'];
const PORTAL = METHODS.length - 1;

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="command">
      {label && <span className="command-label">{label}</span>}
      <pre className="code">{text}</pre>
      <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** Import a tenant's management groups, policy assignments and exemptions from an Azure Resource Graph export. */
export function ImportAzureDialog(props: { catalog: Catalog; onImport: (snapshot: PolicySnapshot) => void; onClose: () => void }) {
  const { catalog, onClose } = props;
  const [tab, setTab] = useState(0);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [label, setLabel] = useState(`Azure ${new Date().toISOString().slice(0, 10)}`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const inputs = [...files.map((f) => f.text), ...(text.trim() ? [text] : [])];
  const result = useMemo(() => {
    if (!inputs.length) return null;
    try {
      return { snapshot: parseAzureImport(inputs, catalog, label.trim() || 'Azure') };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [files, text, catalog, label]);
  const snapshot = result && 'snapshot' in result ? result.snapshot : null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog import-azure" role="dialog" aria-modal="true" aria-label="Import from Azure" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>Import from Azure</h2>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted">
          Reads, through Azure Resource Graph, the management groups, policy assignments and exemptions you can see, with the
          definitions they use. Nothing is changed in Azure.
        </p>
        <div className="file-tabs" role="tablist">
          {METHODS.map((m, i) => (
            <button key={m} role="tab" aria-selected={tab === i} className={tab === i ? 'active' : ''} onClick={() => setTab(i)}>
              {m}
            </button>
          ))}
        </div>

        {tab === PORTAL ? (
          <div className="portal-steps">
            <ol>
              <li>
                Open{' '}
                <a href="https://portal.azure.com/#view/HubsExtension/ArgQueryBlade" target="_blank" rel="noreferrer">
                  Resource Graph Explorer
                </a>{' '}
                in the Azure portal (for Azure Government, in portal.azure.us), with a scope that covers your management groups.
              </li>
              <li>
                Paste query 1 and select <strong>Run query</strong>. Turn <strong>Format results</strong> off, then{' '}
                <strong>Download as CSV</strong>.
              </li>
              <li>Do the same with query 2. Resource Graph allows only one lookup of policy data per query, so there are two.</li>
              <li>Choose both CSV files below.</li>
            </ol>
            {AZURE_IMPORT_QUERIES.map((q, i) => (
              <CopyBlock key={i} text={q} label={`Query ${i + 1}: ${i === 0 ? 'assignments, exemptions, custom definitions, management groups' : 'the assigned built-in definitions'}`} />
            ))}
          </div>
        ) : (
          <>
            <p className="muted">
              Run this with a signed-in Azure CLI: it saves everything to <code>azure-policy.json</code>. Then choose that file or paste its
              contents below.
            </p>
            <CopyBlock text={AZURE_IMPORT_COMMANDS[tab].command} />
          </>
        )}

        <div className="row import-input-row">
          <label className="field">
            Name
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="file-pick">
            {tab === PORTAL ? 'Choose the CSV files' : 'Choose azure-policy.json'}
            <input
              type="file"
              multiple
              accept=".json,.csv,application/json,text/csv,text/plain"
              onChange={async (e) => {
                const chosen = [...(e.target.files ?? [])];
                const read = await Promise.all(chosen.map(async (f) => ({ name: f.name, text: await f.text() })));
                setFiles((current) => [...current.filter((c) => !read.some((r) => r.name === c.name)), ...read]);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {files.length > 0 && (
          <p className="muted chosen-files">
            {files.map((f) => (
              <span key={f.name} className="removed-item">
                <code>{f.name}</code>{' '}
                <button className="link" onClick={() => setFiles(files.filter((x) => x.name !== f.name))}>
                  Remove
                </button>
              </span>
            ))}
          </p>
        )}
        <textarea
          className="import-input mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="…or paste the output (or CSV) here"
          spellCheck={false}
        />

        {result && 'error' in result && (
          <ul className="issues">
            <li className="error">{result.error}</li>
          </ul>
        )}
        {snapshot && (
          <ul className="issues">
            <li className="ok">
              {snapshot.assignments.filter((a) => !a.system).length} policy assignments
              {snapshot.assignments.some((a) => a.system) && <> (plus {snapshot.assignments.filter((a) => a.system).length} Microsoft system ones)</>}{' '}
              across {snapshot.mgs.length} scopes, {snapshot.exemptions.length} exemptions
              {snapshot.frameworks.length > 0 && (
                <>
                  ; frameworks assigned:{' '}
                  {snapshot.frameworks.map((k) => catalog.frameworks.find((f) => f.key === k)?.short ?? k).join(', ')}
                </>
              )}
              .
            </li>
            {snapshot.notes.map((n) => (
              <li key={n} className="info">
                {n}
              </li>
            ))}
          </ul>
        )}
        <div className="row footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!snapshot} onClick={() => snapshot && props.onImport(snapshot)}>
            Import and compare
          </button>
        </div>
      </div>
    </div>
  );
}
