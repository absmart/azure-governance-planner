// Every built-in policy (public/policy-index.json, written by update-catalog),
// for custom assignments. The catalog only carries the policies the frameworks
// and ALZ use, so the picker loads the rest when it opens.

import type { Catalog, PolicyInfo } from './catalog';

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
