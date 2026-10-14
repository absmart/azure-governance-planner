import { useEffect, useState } from 'react';
import type { DesignInput } from '../lib/engine';
import type { ExportSettings } from '../lib/iac';
import { encodeDesign, shareUrl } from '../lib/share';

/** A link that carries the current design, to send to someone. */
export function ShareDialog(props: { input: DesignInput; exportSettings: ExportSettings; onClose: () => void }) {
  const { input, exportSettings, onClose } = props;
  const [includeValues, setIncludeValues] = useState(false);
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const hasValues = Object.values(exportSettings.values).some((v) => v.trim());

  useEffect(() => {
    let current = true;
    encodeDesign(input, exportSettings, { includeValues }).then((token) => current && setUrl(shareUrl(window.location.href, token)));
    return () => {
      current = false;
    };
  }, [input, exportSettings, includeValues]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog share" role="dialog" aria-modal="true" aria-label="Share design" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>Share “{input.name || 'Untitled design'}”</h2>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted">
          The link holds the design itself, compressed after the <code>#</code>, so nothing is uploaded or stored anywhere. Whoever opens
          it gets a copy to change and save; your design isn't affected.
        </p>
        <div className="row share-link">
          <input className="mono" readOnly value={url} aria-label="Design link" onFocus={(e) => e.target.select()} />
          <button className="primary" onClick={copy} disabled={!url}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <p className="muted">{url.length.toLocaleString()} characters</p>
        <label className="check">
          <input type="checkbox" checked={includeValues} disabled={!hasValues} onChange={(e) => setIncludeValues(e.target.checked)} />
          Include the export's environment values (subscription IDs, group object IDs, resource names)
        </label>
        {!includeValues && hasValues && (
          <p className="muted">Left out by default: they describe your environment and the link may be pasted where others can see it.</p>
        )}
      </div>
    </div>
  );
}
