// Summarizes what changed between two catalog snapshots, as Markdown for the
// scheduled update's pull request:
//   node scripts/catalog-diff.mjs <old catalog.json> <new catalog.json>

import { readFileSync } from 'node:fs';

const [before, after] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const out = [];
const LIMIT = 25;

function list(title, items) {
  if (!items.length) return;
  out.push(`**${title}** (${items.length})`, '');
  for (const i of items.slice(0, LIMIT)) out.push(`- ${i}`);
  if (items.length > LIMIT) out.push(`- … and ${items.length - LIMIT} more`);
  out.push('');
}

const keys = (o) => new Set(Object.keys(o ?? {}));
const added = (a, b) => [...keys(b)].filter((k) => !keys(a).has(k));
const removed = (a, b) => [...keys(a)].filter((k) => !keys(b).has(k));
const policyName = (id) => `${after.policies[id]?.n ?? before.policies[id]?.n ?? id} (\`${id}\`)`;

// ALZ library
if (before.alz.ref !== after.alz.ref) out.push(`**ALZ library:** \`${before.alz.ref}\` → \`${after.alz.ref}\``, '');
const archetypes = [...new Set([...keys(before.alz.archetypes), ...keys(after.alz.archetypes)])].flatMap((a) => {
  const was = new Set(before.alz.archetypes[a] ?? []);
  const now = new Set(after.alz.archetypes[a] ?? []);
  return [
    ...[...now].filter((n) => !was.has(n)).map((n) => `\`${a}\`: added \`${n}\``),
    ...[...was].filter((n) => !now.has(n)).map((n) => `\`${a}\`: removed \`${n}\``),
  ];
});
list('ALZ archetype assignments', archetypes);

// Frameworks
const frameworks = after.frameworks.flatMap((f) => {
  const was = before.frameworks.find((x) => x.key === f.key);
  if (!was) return [`${f.short}: new`];
  const changes = [];
  if (was.version !== f.version) changes.push(`version ${was.version} → ${f.version}`);
  if (was.refs.length !== f.refs.length) changes.push(`policies ${was.refs.length} → ${f.refs.length}`);
  if (was.controls.length !== f.controls.length) changes.push(`controls ${was.controls.length} → ${f.controls.length}`);
  return changes.length ? [`${f.short}: ${changes.join(', ')}`] : [];
});
list('Frameworks', frameworks);

// Policies
list('Policies added', added(before.policies, after.policies).map(policyName));
list('Policies removed', removed(before.policies, after.policies).map(policyName));
list(
  'Policies newly deprecated',
  Object.keys(after.policies).filter((id) => after.policies[id].dp && before.policies[id] && !before.policies[id].dp).map(policyName),
);
list(
  'Policies with a new version',
  Object.keys(after.policies)
    .filter((id) => before.policies[id] && before.policies[id].v !== after.policies[id].v)
    .map((id) => `${policyName(id)}: ${before.policies[id].v} → ${after.policies[id].v}`),
);

console.log(out.length ? out.join('\n') : 'Only descriptions and other metadata changed.');
