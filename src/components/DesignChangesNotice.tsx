import { changesSummary, type DesignChanges } from '../lib/baseline';
import type { Catalog } from '../lib/catalog';
import { policyLabel } from '../lib/snapshot';

const LIMIT = 40;

function List(props: { title: string; items: string[] }) {
  if (!props.items.length) return null;
  return (
    <>
      <h4>
        {props.title} ({props.items.length})
      </h4>
      <ul>
        {props.items.slice(0, LIMIT).map((x) => (
          <li key={x}>{x}</li>
        ))}
        {props.items.length > LIMIT && <li className="muted">and {props.items.length - LIMIT} more</li>}
      </ul>
    </>
  );
}

/** What a reopened saved design deploys differently from when it was saved. */
export function DesignChangesNotice(props: { catalog: Catalog; name: string; changes: DesignChanges; onReviewed: () => void; onDismiss: () => void }) {
  const { catalog, name, changes: c } = props;
  const label = (p: string) => policyLabel(catalog, p);
  return (
    <div className="design-changes">
      <p>
        <strong>"{name}" deploys differently from when it was saved</strong> (catalog {c.from.catalog} → {c.to.catalog}): {changesSummary(c)}. The
        policy catalog or the app changed underneath it; review before exporting again.
      </p>
      <details>
        <summary>What changed</summary>
        <List title="Assignments added" items={c.assignmentsAdded.map((a) => `${a.displayName} (${a.key})`)} />
        <List title="Assignments removed" items={c.assignmentsRemoved.map((a) => `${a.displayName} (${a.key})`)} />
        <List title="Assignments changed" items={c.assignmentsChanged.map((a) => `${a.displayName} (${a.key}): ${a.what}`)} />
        <List title="Policies added" items={c.policiesAdded.map(label)} />
        <List title="Policies removed" items={c.policiesRemoved.map(label)} />
        <List title="Effects changed" items={c.effectsChanged.map((e) => `${label(e.p)}: ${e.before} → ${e.after}`)} />
      </details>
      <div className="row">
        <button className="primary" onClick={props.onReviewed} title="Remember what the design deploys now, so this notice only comes back for later changes">
          Mark as reviewed
        </button>
        <button onClick={props.onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
