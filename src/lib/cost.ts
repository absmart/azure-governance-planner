// A rough monthly cost of what a design turns on: the Defender for Cloud plans,
// Log Analytics ingestion, Azure Backup and DDoS Network Protection, from the
// quantities the user enters and approximate pay-as-you-go list prices.

import { DEFENDER_PLANS } from './defender';
import type { DesignInput } from './engine';

/** What the estimate is based on: rough counts of the estate the design governs. */
export interface CostQuantities {
  subscriptions: number;
  servers: number;
  /** Azure SQL logical servers and managed instances. */
  sqlServers: number;
  sqlOnVm: number;
  /** PostgreSQL, MySQL and MariaDB servers. */
  ossDbServers: number;
  /** Provisioned Cosmos DB throughput, RU/s. */
  cosmosRu: number;
  appServiceInstances: number;
  storageAccounts: number;
  /** vCores of the AKS clusters' nodes. */
  aksVCores: number;
  keyVaults: number;
  /** Tokens through Azure OpenAI / AI services a month, in millions. */
  aiTokensMillions: number;
  /** Log Analytics ingestion, GB a day. */
  logGbPerDay: number;
  backupInstances: number;
  /** Backup storage used, GB. */
  backupGb: number;
}

export const DEFAULT_COST_QUANTITIES: CostQuantities = {
  subscriptions: 10,
  servers: 20,
  sqlServers: 2,
  sqlOnVm: 0,
  ossDbServers: 1,
  cosmosRu: 0,
  appServiceInstances: 4,
  storageAccounts: 10,
  aksVCores: 0,
  keyVaults: 5,
  aiTokensMillions: 0,
  logGbPerDay: 5,
  backupInstances: 10,
  backupGb: 1000,
};

export const QUANTITY_LABEL: Record<keyof CostQuantities, string> = {
  subscriptions: 'Subscriptions',
  servers: 'Servers (VMs and Arc machines)',
  sqlServers: 'Azure SQL servers and managed instances',
  sqlOnVm: 'SQL Servers on machines',
  ossDbServers: 'PostgreSQL / MySQL / MariaDB servers',
  cosmosRu: 'Cosmos DB throughput (RU/s)',
  appServiceInstances: 'App Service instances',
  storageAccounts: 'Storage accounts',
  aksVCores: 'AKS node vCores',
  keyVaults: 'Key vaults',
  aiTokensMillions: 'AI tokens a month (millions)',
  logGbPerDay: 'Log Analytics ingestion (GB a day)',
  backupInstances: 'Backed-up VMs',
  backupGb: 'Backup storage (GB)',
};

const HOURS = 730;
const DAYS = 30.4;

/**
 * Approximate US pay-as-you-go list prices in USD. They change and vary by
 * region (Azure Government is higher); the estimate says so and links to the
 * pricing calculator. Keep them here so they're easy to update.
 */
export const PRICES = {
  defender: {
    Servers: 15, // per server a month (Plan 2)
    ServersVulnerabilityAssessments: 0, // included with Defender for Servers
    Sql: 15, // per server or managed instance
    SqlOnVm: 15, // per server
    OssDb: 15, // per server
    CosmosDbs: 0.0012 * HOURS, // per 100 RU/s a month
    AppServices: 15, // per instance
    Storage: 10, // per storage account (malware scanning is extra)
    Containers: 6.8693, // per vCore
    KeyVault: 0.25, // per vault
    Arm: 4, // per subscription
    Cspm: 5.11, // per billable server, database and storage account
    AI: 0.0008 * 1000, // per million tokens
  } as Record<string, number>,
  logAnalyticsPerGb: 2.3,
  /** Defender for Servers Plan 2 includes this much Log Analytics ingestion per server a day. */
  serverLogAllowanceGb: 0.5,
  backupPerInstance: 10, // 50-500 GB VM
  backupPerGb: 0.0448, // GRS
  ddosPlan: 2944,
};

export interface CostLine {
  group: 'Defender for Cloud' | 'Monitoring' | 'Backup' | 'Networking';
  item: string;
  /** The quantity it scales with, when the user can change it. */
  quantity?: keyof CostQuantities;
  amount: number;
  unit: string;
  unitPrice: number;
  monthly: number;
  note?: string;
}

/** The quantity each Defender plan is billed by. */
const PLAN_QUANTITY: Record<string, { quantity: keyof CostQuantities; unit: string; scale?: number }> = {
  Servers: { quantity: 'servers', unit: 'server' },
  ServersVulnerabilityAssessments: { quantity: 'servers', unit: 'server' },
  Sql: { quantity: 'sqlServers', unit: 'server' },
  SqlOnVm: { quantity: 'sqlOnVm', unit: 'server' },
  OssDb: { quantity: 'ossDbServers', unit: 'server' },
  CosmosDbs: { quantity: 'cosmosRu', unit: '100 RU/s', scale: 1 / 100 },
  AppServices: { quantity: 'appServiceInstances', unit: 'instance' },
  Storage: { quantity: 'storageAccounts', unit: 'account' },
  Containers: { quantity: 'aksVCores', unit: 'vCore' },
  KeyVault: { quantity: 'keyVaults', unit: 'vault' },
  Arm: { quantity: 'subscriptions', unit: 'subscription' },
  AI: { quantity: 'aiTokensMillions', unit: 'million tokens' },
};

export interface CostEstimate {
  lines: CostLine[];
  monthly: number;
  notes: string[];
}

export function estimateCost(input: DesignInput, q: CostQuantities = input.costQuantities ?? DEFAULT_COST_QUANTITIES): CostEstimate {
  const lines: CostLine[] = [];
  const notes: string[] = [];
  const line = (l: Omit<CostLine, 'monthly'>) => lines.push({ ...l, monthly: l.amount * l.unitPrice });
  const plans = new Set(input.defender ? input.defenderPlans : []);

  if (input.defender)
    for (const p of DEFENDER_PLANS) {
      if (!plans.has(p.key)) continue;
      if (p.key === 'Cspm') {
        const billable = q.servers + q.sqlServers + q.sqlOnVm + q.ossDbServers + q.storageAccounts;
        line({ group: 'Defender for Cloud', item: p.label, amount: billable, unit: 'billable resource', unitPrice: PRICES.defender.Cspm, note: 'Servers, databases and storage accounts.' });
        continue;
      }
      const b = PLAN_QUANTITY[p.key];
      line({
        group: 'Defender for Cloud',
        item: p.label,
        quantity: b.quantity,
        amount: q[b.quantity] * (b.scale ?? 1),
        unit: b.unit,
        unitPrice: PRICES.defender[p.key] ?? 0,
        ...(p.key === 'ServersVulnerabilityAssessments' ? { note: 'Included with Defender for Servers.' } : {}),
        ...(p.key === 'Storage' ? { note: 'Malware scanning is billed per GB scanned on top.' } : {}),
      });
    }

  if (input.monitoring || input.defender) {
    const allowance = plans.has('Servers') ? q.servers * PRICES.serverLogAllowanceGb : 0;
    const billedPerDay = Math.max(0, q.logGbPerDay - allowance);
    line({
      group: 'Monitoring',
      item: 'Log Analytics ingestion',
      quantity: 'logGbPerDay',
      amount: billedPerDay * DAYS,
      unit: 'GB',
      unitPrice: PRICES.logAnalyticsPerGb,
      note: `${q.logGbPerDay} GB a day${allowance ? `, less Defender for Servers' ${PRICES.serverLogAllowanceGb} GB per server a day` : ''}. Commitment tiers cost less from 100 GB a day; retention past 31 days is extra.`,
    });
  }

  if (input.backup) {
    line({ group: 'Backup', item: 'Protected VMs', quantity: 'backupInstances', amount: q.backupInstances, unit: 'VM', unitPrice: PRICES.backupPerInstance, note: 'VMs of 50-500 GB.' });
    line({ group: 'Backup', item: 'Backup storage (GRS)', quantity: 'backupGb', amount: q.backupGb, unit: 'GB', unitPrice: PRICES.backupPerGb });
  }

  if (input.ddos) line({ group: 'Networking', item: 'DDoS Network Protection plan', amount: 1, unit: 'plan', unitPrice: PRICES.ddosPlan, note: 'Covers up to 100 public IP addresses; more are billed per IP.' });

  if (input.cloud === 'AzureUSGovernment') notes.push('Azure Government prices are higher than these commercial list prices.');
  notes.push('Approximate US pay-as-you-go list prices in USD, before discounts, reservations and regional differences. Check the Azure pricing calculator before relying on them.');
  return { lines, monthly: lines.reduce((n, l) => n + l.monthly, 0), notes };
}

export const formatUsd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 && n % 1 ? 2 : 0 })}`;
