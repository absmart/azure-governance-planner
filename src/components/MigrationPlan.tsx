import { useState } from 'react';
import { downloadFile } from '../lib/download';
import type { Design } from '../lib/engine';
import type { MigrationExport } from '../lib/iac';
import { auditFirstDesign, migrationMarkdown, type MigrationPlan as Plan } from '../lib/migration';

const STEPS_SHOWN = 30;

function Phase({ phase }: { phase: Plan['phases'][number] }) {
  const [all, setAll] = useState(false);
  const steps = all ? phase.steps : phase.steps.slice(0, STEPS_SHOWN);
  return (
    <details className="migration-phase" open={phase.steps.length > 0 && phase.steps.length <= 12}>
      <summary>
        <strong>{phase.title}</strong> <span className="muted">({phase.steps.length ? `${phase.steps.length} steps` : 'nothing to do'})</span>
      </summary>
      <p className="muted">{phase.description}</p>
      {steps.length > 0 && (
        <ol className="migration-steps">
          {steps.map((s, i) => (
            <li key={`${s.kind}-${s.scope}-${s.assignment ?? ''}-${i}`}>
              <strong>{s.title}</strong> <span className="muted">· {s.scopeName}</span>
              {s.assignment && (
                <>
                  {' '}
                  <code>{s.assignment}</code>
                </>
              )}
              {s.nonCompliant !== undefined && (
                <span className={`badge ${s.nonCompliant ? 'warn' : 'mode-audit'}`}>
                  {s.nonCompliant ? `${s.nonCompliant.toLocaleString()} non-compliant` : 'no non-compliant resources'}
                </span>
              )}
              <div className="muted">{s.detail}</div>
              {s.command && <code className="command">{s.command}</code>}
            </li>
          ))}
        </ol>
      )}
      {phase.steps.length > steps.length && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {phase.steps.length}
        </button>
      )}
    </details>
  );
}

/** The steps from an Azure import to a design, and the exports for its deployments. */
export function MigrationPlan(props: {
  plan: Plan;
  design: Design;
  onExport: (design: Design, migration: MigrationExport & { title: string }) => void;
  /** Set the current design's prefix to the tenant's (only offered for the current design). */
  onUsePrefix?: (prefix: string) => void;
}) {
  const { plan, design } = props;
  const markdown = migrationMarkdown(plan);
  const migration = { plan: markdown, existing: plan.existing };
  const counts = plan.phases.map((p) => p.steps.length);
  return (
    <section className="card migration">
      <header className="row">
        <h2>Migration plan</h2>
        <span className="muted">
          {plan.current} → {plan.target}
        </span>
      </header>
      <p className="muted">
        From what's deployed to the design: {counts[0]} management groups to create, {counts[1]} assignment changes in report-only mode,{' '}
        {counts[3]} to enforce once compliance is reviewed and {counts[4]} to remove. {plan.unchanged} assignments are already as designed
        and {plan.matchedMgs} of the {design.mgs.length} management groups exist.
      </p>
      {plan.notes.length > 0 && (
        <ul className="issues">
          {plan.notes.map((n) => (
            <li key={n} className="info">
              {n}
            </li>
          ))}
        </ul>
      )}
      {plan.suggestedPrefix && props.onUsePrefix && (
        <p>
          <button onClick={() => props.onUsePrefix!(plan.suggestedPrefix!)}>Use the prefix "{plan.suggestedPrefix}"</button>
        </p>
      )}
      <div className="row">
        <button
          className="primary"
          onClick={() =>
            props.onExport(auditFirstDesign(design, plan), { ...migration, title: 'Export migration phases 1–2: audit first' })
          }
        >
          Export phases 1–2 (audit first)
        </button>
        <button onClick={() => props.onExport(design, { ...migration, title: 'Export migration phase 4: the full design' })}>
          Export phase 4 (enforce)
        </button>
        <button onClick={() => downloadFile('MIGRATION.md', markdown, 'text/markdown')}>Download plan (.md)</button>
      </div>
      {plan.phases.map((p) => (
        <Phase key={p.key} phase={p} />
      ))}
    </section>
  );
}
