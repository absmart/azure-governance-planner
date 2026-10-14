import { useEffect, useMemo, useState } from 'react';
import type { Catalog } from '../lib/catalog';
import { AZURE_IMPORT_COMMANDS, parseAzureImport, type PolicySnapshot } from '../lib/snapshot';

/** Import a tenant's management groups, policy assignments and exemptions from an Azure Resource Graph export. */
export function ImportAzureDialog(props: { catalog: Catalog; onImport: (snapshot: PolicySnapshot) => void; onClose: () => void }) {
  const { catalog, onClose } = props;
  const [tab, setTab] = useState(0);
  const [text, setText] = useState('');
  const [label, setLabel] = useState(`Azure ${new Date().toISOString().slice(0, 10)}`);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const result = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { snapshot: parseAzureImport(text, catalog, label.trim() || 'Azure') };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [text, catalog, label]);
  const snapshot = result && 'snapshot' in result ? result.snapshot : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(AZURE_IMPORT_COMMANDS[tab].command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

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
          Run this with a signed-in Azure CLI (it only reads, through Azure Resource Graph): it saves the management groups, policy
          assignments and exemptions you can see, with the definitions they use, to <code>azure-policy.json</code>. Then paste the
          file's contents below or choose the file.
        </p>
        <div className="file-tabs" role="tablist">
          {AZURE_IMPORT_COMMANDS.map((c, i) => (
            <button key={c.label} role="tab" aria-selected={tab === i} className={tab === i ? 'active' : ''} onClick={() => setTab(i)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="command">
          <pre className="code">{AZURE_IMPORT_COMMANDS[tab].command}</pre>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>

        <div className="row import-input-row">
          <label className="field">
            Name
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="file-pick">
            Choose azure-policy.json
            <input
              type="file"
              accept=".json,application/json,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setText(await file.text());
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <textarea
          className="import-input mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="…or paste the output here"
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
