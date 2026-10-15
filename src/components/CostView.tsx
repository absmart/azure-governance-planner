import { DEFAULT_COST_QUANTITIES, QUANTITY_LABEL, estimateCost, formatUsd, type CostLine, type CostQuantities } from '../lib/cost';
import type { DesignInput } from '../lib/engine';

const GROUPS: CostLine['group'][] = ['Defender for Cloud', 'Monitoring', 'Backup', 'Networking'];

/** "20 servers", "1 VM", "4 × 100 RU/s", "152 GB". */
function quantityText(l: CostLine): string {
  const amount = (Math.round(l.amount * 100) / 100).toLocaleString('en-US');
  if (/^\d/.test(l.unit)) return `${amount} × ${l.unit}`;
  if (l.unit === 'GB' || l.amount === 1) return `${amount} ${l.unit}`;
  return `${amount} ${l.unit}s`;
}

/** A rough monthly cost of what the design turns on, from counts the user enters. */
export function CostView({ input, onChange }: { input: DesignInput; onChange: (input: DesignInput) => void }) {
  const q = input.costQuantities ?? DEFAULT_COST_QUANTITIES;
  const estimate = estimateCost(input, q);
  const setQuantity = (k: keyof CostQuantities, value: string) => {
    const n = Number(value);
    onChange({ ...input, costQuantities: { ...q, [k]: Number.isFinite(n) && n >= 0 ? n : 0 } });
  };
  // Only the quantities a line in the estimate uses.
  const used = [...new Set(estimate.lines.flatMap((l) => (l.quantity ? [l.quantity] : [])))];
  if (input.defender && input.defenderPlans.includes('Cspm'))
    for (const k of ['servers', 'sqlServers', 'sqlOnVm', 'ossDbServers', 'storageAccounts'] as const) if (!used.includes(k)) used.push(k);

  return (
    <section className="card cost">
      <header className="row">
        <h2>Cost estimate</h2>
        <span className="cost-total">
          ≈ <strong>{formatUsd(estimate.monthly)}</strong> a month · {formatUsd(estimate.monthly * 12)} a year
        </span>
      </header>
      <p className="muted">
        What the design's decisions cost to run: the Defender plans, Log Analytics ingestion, Backup and DDoS Network Protection. Enter
        rough counts of the estate it will govern. Policy itself is free.
      </p>

      {used.length > 0 && (
        <div className="input-grid cost-quantities">
          {(Object.keys(QUANTITY_LABEL) as (keyof CostQuantities)[])
            .filter((k) => used.includes(k))
            .map((k) => (
              <label key={k} className="field">
                {QUANTITY_LABEL[k]}
                <input type="number" min={0} value={q[k]} onChange={(e) => setQuantity(k, e.target.value)} />
              </label>
            ))}
        </div>
      )}

      {estimate.lines.length ? (
        <div className="table-scroll">
          <table className="cost-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th className="num">Unit price</th>
                <th className="num">Monthly</th>
              </tr>
            </thead>
            {GROUPS.filter((g) => estimate.lines.some((l) => l.group === g)).map((g) => {
              const lines = estimate.lines.filter((l) => l.group === g);
              return (
                <tbody key={g}>
                  <tr className="cost-group">
                    <th colSpan={3}>{g}</th>
                    <th className="num">{formatUsd(lines.reduce((n, l) => n + l.monthly, 0))}</th>
                  </tr>
                  {lines.map((l) => (
                    <tr key={l.item}>
                      <td>
                        {l.item}
                        {l.note && <div className="muted">{l.note}</div>}
                      </td>
                      <td className="num">{quantityText(l)}</td>
                      <td className="num">{formatUsd(l.unitPrice)}</td>
                      <td className="num">{formatUsd(l.monthly)}</td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
      ) : (
        <p className="muted">Nothing with a running cost is turned on: Defender for Cloud, monitoring, backup and DDoS protection are all off.</p>
      )}
      {estimate.notes.map((n) => (
        <p key={n} className="muted">
          {n}{' '}
          {n.includes('pricing calculator') && (
            <a href="https://azure.microsoft.com/pricing/calculator/" target="_blank" rel="noreferrer">
              Open the calculator ↗
            </a>
          )}
        </p>
      ))}
    </section>
  );
}
