// Every built-in policy and initiative (public/policy-index.json and
// public/initiative-index.json, written by update-catalog), for custom
// assignments. The catalog only carries what the frameworks and ALZ use, so the
// picker loads the rest when it opens.

import type { Catalog, Member, PolicyInfo } from './catalog';

export interface PolicyIndex {
  generated: string;
  policies: Record<string, PolicyInfo>;
}

let request: Promise<PolicyIndex> | undefined;

/** Fetches the index once; a failed fetch can be retried. */
export function loadPolicyIndex(): Promise<PolicyIndex> {
  request ??= fetch(`${import.meta.env.BASE_URL}policy-index.json`).then((r) => {
    if (!r.ok) throw new Error(`policy-index.json: HTTP ${r.status}`);
    return r.json() as Promise<PolicyIndex>;
  });
  request.catch(() => (request = undefined));
  return request;
}

/** Built-in policies (catalog and index) matching every word of a query in name, category or GUID; by name, deprecated ones last. */
export function searchPolicies(catalog: Catalog, index: PolicyIndex | null, query: string, limit = 50): { id: string; info: PolicyInfo }[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const all = new Map<string, PolicyInfo>();
  for (const [id, info] of Object.entries(catalog.policies)) if (info.t === 'BuiltIn') all.set(id, info);
  for (const [id, info] of Object.entries(index?.policies ?? {})) if (!all.has(id)) all.set(id, info);
  const out: { id: string; info: PolicyInfo }[] = [];
  for (const [id, info] of all) {
    const text = `${info.n} ${info.c} ${id}`.toLowerCase();
    if (words.every((w) => text.includes(w))) out.push({ id, info });
  }
  return out.sort((a, b) => Number(!!a.info.dp) - Number(!!b.info.dp) || a.info.n.localeCompare(b.info.n)).slice(0, limit);
}

/** A built-in initiative in public/initiative-index.json; members are [policy GUID, default effect, reference ID]. */
export interface IndexedInitiative {
  n: string;
  c: string;
  v: string;
  d: string;
  ng?: true;
  m: [string, string, string][];
}

export interface InitiativeIndex {
  generated: string;
  initiatives: Record<string, IndexedInitiative>;
}

let initiativeRequest: Promise<InitiativeIndex> | undefined;

/** Fetches every built-in initiative once; a failed fetch can be retried. */
export function loadInitiativeIndex(): Promise<InitiativeIndex> {
  initiativeRequest ??= fetch(`${import.meta.env.BASE_URL}initiative-index.json`).then((r) => {
    if (!r.ok) throw new Error(`initiative-index.json: HTTP ${r.status}`);
    return r.json() as Promise<InitiativeIndex>;
  });
  initiativeRequest.catch(() => (initiativeRequest = undefined));
  return initiativeRequest;
}

/** Built-in initiatives matching every word of a query in name, category or GUID; by name. */
export function searchInitiatives(index: InitiativeIndex | null, query: string, limit = 50): { id: string; initiative: IndexedInitiative }[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || !index) return [];
  return Object.entries(index.initiatives)
    .filter(([id, i]) => words.every((w) => `${i.n} ${i.c} ${id}`.toLowerCase().includes(w)))
    .map(([id, initiative]) => ({ id, initiative }))
    .sort((a, b) => a.initiative.n.localeCompare(b.initiative.n))
    .slice(0, limit);
}

/**
 * What a custom assignment of an indexed initiative stores: its members, and
 * the details of those the catalog doesn't carry (without descriptions, to keep
 * saved designs and links small).
 */
export function initiativeMembers(
  catalog: Catalog,
  policies: PolicyIndex | null,
  initiative: IndexedInitiative,
): { members: Member[]; infos: Record<string, PolicyInfo> } {
  const byPolicy = new Map<string, Member>();
  for (const [p, e, r] of initiative.m) {
    const seen = byPolicy.get(p);
    if (seen) seen.r = [...(seen.r ?? []), r];
    else byPolicy.set(p, { p, e: e || catalog.policies[p]?.e || policies?.policies[p]?.e || '', r: [r] });
  }
  const infos: Record<string, PolicyInfo> = {};
  for (const p of byPolicy.keys()) {
    const info = policies?.policies[p];
    if (!catalog.policies[p] && info) infos[p] = { ...info, d: '' };
  }
  return { members: [...byPolicy.values()], infos };
}
