import type { ReactNode } from 'react';
import { portalInitiativeUrl, type Catalog } from '../lib/catalog';
import { PRIVATE_DNS_CATEGORIES } from '../lib/privateDns';
import type { Baseline, DesignInput, Enforcement, MgRole } from '../lib/engine';

type BoolKey = { [K in keyof DesignInput]: DesignInput[K] extends boolean ? K : never }[keyof DesignInput];

const POSTURES: { value: Enforcement; label: string; help: string }[] = [
  {
    value: 'audit',
    label: 'Audit first',
    help: 'Nothing is blocked. Deny guardrails run in DoNotEnforce; remediation (DeployIfNotExists, Modify) still runs.',
  },
  {
    value: 'alz',
    label: 'ALZ defaults',
    help: 'The Azure Landing Zones library as shipped. Framework Deny candidates are added in DoNotEnforce, as a what-if.',
  },
  {
    value: 'strict',
    label: 'Strict',
    help: 'Every guardrail is enforced, including the framework enforcement initiative on landing zones.',
  },
];

const BASELINES: { value: Baseline; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'high', label: 'High' },
  { value: 'all', label: 'All controls' },
];

const GUARDRAILS: { key: BoolKey; label: string; help: string }[] = [
  { key: 'defender', label: 'Defender for Cloud', help: 'Deploy Defender plans and endpoint protection (ALZ Deploy-MDFC-*).' },
  { key: 'monitoring', label: 'Central monitoring', help: 'Activity logs, diagnostic settings and Azure Monitor Agent to the central workspace.' },
  { key: 'backup', label: 'Backup and recovery', help: 'Azure Backup for VMs and Site Recovery.' },
  { key: 'privateCorp', label: 'Private-only Corp', help: 'Deny public PaaS endpoints in Corp and register private endpoints in central private DNS zones.' },
  {
    key: 'ddos',
    label: 'DDoS Network Protection',
    help: 'Associate virtual networks with an existing DDoS protection plan. A plan costs about US$2,944 a month, so this is off by default.',
  },
  { key: 'cmk', label: 'Customer-managed keys', help: 'Enforce encryption with customer-managed keys (ALZ ships it in DoNotEnforce).' },
  { key: 'sovereignty', label: 'Sovereignty baseline', help: 'Microsoft Cloud for Sovereignty global policies: allowed regions and Trusted Launch.' },
];

/** Comma-separated list input. Keeps what the user typed (including a trailing comma). */
function ListInput(props: { value: string[]; placeholder: string; onChange: (value: string[]) => void }) {
  return (
    <input
      className="wide"
      value={props.value.join(',')}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value.split(','))}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="decision">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Decisions(props: { catalog: Catalog; input: DesignInput; onChange: (input: DesignInput) => void }) {
  const { catalog, input, onChange } = props;
  const set = <K extends keyof DesignInput>(key: K, value: DesignInput[K]) => onChange({ ...input, [key]: value });
  const check = (key: BoolKey, label: string, help?: string) => (
    <label className="check" title={help}>
      <input type="checkbox" checked={input[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  );

  const toggleFramework = (key: string, on: boolean) =>
    set('frameworks', on ? [...input.frameworks, key] : input.frameworks.filter((k) => k !== key));

  const groups = [...new Set(catalog.frameworks.map((f) => f.group))];
  const scopes: { role: MgRole; label: string }[] = [
    { role: 'root', label: 'All subscriptions' },
    { role: 'landingzones', label: 'Landing zones' },
    ...(input.corp ? [{ role: 'corp' as const, label: 'Corp' }] : []),
    ...(input.online ? [{ role: 'online' as const, label: 'Online' }] : []),
    ...(input.confidential ? [{ role: 'confidential-corp' as const, label: 'Confidential Corp' }] : []),
  ];
  const nistSelected = catalog.frameworks.some((f) => f.nist && input.frameworks.includes(f.key));

  return (
    <aside className="decisions">
      <Section title="Organization">
        <label className="field">
          Root management group
          <input className="wide" value={input.rootName} onChange={(e) => set('rootName', e.target.value)} />
        </label>
        <label className="field">
          ID prefix
          <input className="wide mono" value={input.prefix} onChange={(e) => set('prefix', e.target.value)} />
        </label>
        <label className="field">
          Cloud
          <select value={input.cloud} onChange={(e) => set('cloud', e.target.value as DesignInput['cloud'])}>
            <option value="AzureCloud">Azure commercial</option>
            <option value="AzureUSGovernment">Azure Government</option>
          </select>
        </label>
      </Section>

      <Section title="Frameworks">
        <p className="muted">Each one assigns its built-in regulatory compliance initiative (audit-only).</p>
        {groups.map((group) => (
          <div key={group} className="fw-group">
            <h4>{group}</h4>
            {catalog.frameworks
              .filter((f) => f.group === group)
              .map((f) => {
                const on = input.frameworks.includes(f.key);
                const unavailable = input.cloud === 'AzureUSGovernment' && f.usGov === false;
                return (
                  <div key={f.key} className={`fw ${on ? 'on' : ''}`}>
                    <label className="check" title={f.description}>
                      <input type="checkbox" checked={on} onChange={(e) => toggleFramework(f.key, e.target.checked)} />
                      <span>{f.short}</span>
                      {unavailable && <span className="badge warn" title="Not available in Azure Government">no Gov</span>}
                    </label>
                    <a className="muted" href={portalInitiativeUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                      {f.controls.length} controls
                    </a>
                    {on && f.key !== 'mcsb' && (
                      <select
                        className="fw-scope"
                        title="Where the compliance initiative is assigned"
                        value={input.frameworkScopes[f.key] ?? 'root'}
                        onChange={(e) => set('frameworkScopes', { ...input.frameworkScopes, [f.key]: e.target.value as MgRole })}
                      >
                        {scopes.map((s) => (
                          <option key={s.role} value={s.role}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
        {nistSelected && (
          <div className="baseline">
            <label className="field" title="NIST SP 800-53B control baseline used for coverage and enforcement candidates">
              NIST 800-53 baseline
              <select value={input.nistBaseline} onChange={(e) => set('nistBaseline', e.target.value as Baseline)}>
                {BASELINES.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            {input.nistBaseline !== 'all' && check('nistPrivacy', 'Add privacy baseline')}
          </div>
        )}
      </Section>

      <Section title="Enforcement posture">
        {POSTURES.map((p) => (
          <label key={p.value} className={`posture ${input.enforcement === p.value ? 'on' : ''}`}>
            <input
              type="radio"
              name="enforcement"
              checked={input.enforcement === p.value}
              onChange={() => set('enforcement', p.value)}
            />
            <span>
              <strong>{p.label}</strong>
              <span className="muted">{p.help}</span>
            </span>
          </label>
        ))}
      </Section>

      <Section title="Management groups">
        <label className="field">
          Platform
          <select value={input.platform} onChange={(e) => set('platform', e.target.value as DesignInput['platform'])}>
            <option value="full">Separate subscriptions: Connectivity, Identity, Management, Security groups</option>
            <option value="single">Single platform subscription: one Platform group</option>
          </select>
        </label>
        {check('corp', 'Corp landing zones', 'Private workloads connected to the hub')}
        {check('online', 'Online landing zones', 'Internet-facing workloads')}
        {check('confidential', 'Confidential landing zones', 'Confidential Corp and Online (Sovereign Landing Zone)')}
        {check('sandbox', 'Sandbox')}
        {check('decommissioned', 'Decommissioned')}
      </Section>

      <Section title="Guardrails">
        {GUARDRAILS.map((g) => (
          <div key={g.key}>{check(g.key, g.label, g.help)}</div>
        ))}
      </Section>

      {input.privateCorp && (
        <Section title="Private DNS zones">
          <p className="muted">Created by the IaC export in the private DNS zone resource group, for private endpoints.</p>
          {PRIVATE_DNS_CATEGORIES.map((c) => (
            <label key={c.key} className="check" title={c.zones.join(', ')}>
              <input
                type="checkbox"
                checked={input.privateDnsZones.includes(c.key)}
                onChange={(e) =>
                  set('privateDnsZones', e.target.checked ? [...input.privateDnsZones, c.key] : input.privateDnsZones.filter((k) => k !== c.key))
                }
              />
              {c.label}
              <span className="muted">{c.zones.length}</span>
            </label>
          ))}
        </Section>
      )}

      <Section title="Locations and tags">
        <label className="field">
          Allowed locations
          <ListInput value={input.allowedLocations} placeholder="eastus2,centralus" onChange={(v) => set('allowedLocations', v)} />
        </label>
        <label className="field">
          Required resource group tags
          <ListInput value={input.requiredTags} placeholder="CostCenter,Environment" onChange={(v) => set('requiredTags', v)} />
        </label>
      </Section>
    </aside>
  );
}
