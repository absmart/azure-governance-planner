import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_QUANTITIES, PRICES, estimateCost, formatUsd } from './cost';
import { DEFAULT_INPUT, type DesignInput } from './engine';

const estimate = (input: Partial<DesignInput> = {}) => estimateCost({ ...DEFAULT_INPUT, ...input });
const line = (e: ReturnType<typeof estimate>, item: string) => e.lines.find((l) => l.item === item);

describe('cost estimate', () => {
  it('prices the default plans, monitoring and backup, and adds them up', () => {
    const e = estimate();
    expect(line(e, 'Servers')).toMatchObject({ amount: 20, unitPrice: 15, monthly: 300 });
    expect(line(e, 'Servers vulnerability assessment')!.monthly).toBe(0);
    expect(line(e, 'Defender CSPM')).toBeUndefined();
    expect(line(e, 'Protected VMs')).toMatchObject({ amount: 10, monthly: 100 });
    expect(line(e, 'DDoS Network Protection plan')).toBeUndefined();
    expect(e.monthly).toBeCloseTo(e.lines.reduce((n, l) => n + l.monthly, 0));
    expect(e.notes.at(-1)).toMatch(/pricing calculator/);
  });

  it('takes Defender for Servers\' ingestion allowance off Log Analytics', () => {
    // 20 servers × 0.5 GB covers the default 5 GB a day.
    expect(line(estimate(), 'Log Analytics ingestion')!.monthly).toBe(0);
    const heavy = estimate({ costQuantities: { ...DEFAULT_COST_QUANTITIES, logGbPerDay: 30 } });
    expect(line(heavy, 'Log Analytics ingestion')!.monthly).toBeCloseTo(20 * 30.4 * PRICES.logAnalyticsPerGb);
    const noServers = estimate({ defenderPlans: ['Sql'] });
    expect(line(noServers, 'Log Analytics ingestion')!.monthly).toBeCloseTo(5 * 30.4 * PRICES.logAnalyticsPerGb);
  });

  it('bills CSPM per server, database and storage account, and DDoS per plan', () => {
    const e = estimate({ defenderPlans: [...DEFAULT_INPUT.defenderPlans, 'Cspm'], ddos: true });
    const q = DEFAULT_COST_QUANTITIES;
    expect(line(e, 'Defender CSPM')!.amount).toBe(q.servers + q.sqlServers + q.sqlOnVm + q.ossDbServers + q.storageAccounts);
    expect(line(e, 'DDoS Network Protection plan')!.monthly).toBe(2944);
  });

  it('costs nothing with every paid decision off, and warns about Government prices', () => {
    expect(estimate({ defender: false, monitoring: false, backup: false, ddos: false }).monthly).toBe(0);
    expect(estimate({ cloud: 'AzureUSGovernment' }).notes[0]).toMatch(/Government/);
    expect(formatUsd(2944)).toBe('$2,944');
    expect(formatUsd(0.25)).toBe('$0.25');
  });
});
