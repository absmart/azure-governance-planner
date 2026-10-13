import { useState } from 'react';
import type { Design, DesignInput, MgRole } from '../lib/engine';
import { DEFAULT_PIM, PIM_ROLES, PROFILE_SETTINGS, pimProfileFor, type PimEligibility, type PimInput, type PimRoleKey } from '../lib/pim';

const duration = (iso: string) =>
  iso.startsWith('PT') ? `${iso.slice(2, -1)} hour${iso.slice(2, -1) === '1' ? '' : 's'}` : `${iso.slice(1, -1)} days`;

let seq = 0;

/** Privileged Identity Management for Azure resource roles: profile, roles, eligible groups and the controls it addresses. */
export function PrivilegedAccess({ design, input, onChange }: { design: Design; input: DesignInput; onChange: (input: DesignInput) => void }) {
  const pim: PimInput = input.pim ?? DEFAULT_PIM;
  const set = (next: Partial<PimInput>) => onChange({ ...input, pim: { ...pim, ...next } });
  const auto = pimProfileFor(
    design.coverage.map((c) => c.key),
    input.nistBaseline,
  );
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<PimRoleKey>('owner');
  const [mg, setMg] = useState<MgRole>('root');
  const p = design.pim;

  const mgName = (role: MgRole) => design.mgs.find((m) => m.role === role)?.displayName ?? role;
  const addEligibility = () => {
    if (!label.trim()) return;
    const e: PimEligibility = { id: `${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(seq++).toString(36)}`, label: label.trim(), role, mg };
    set({ eligibilities: [...pim.eligibilities, e] });
    setLabel('');
  };

  return (
    <section className="card pim">
      <header className="row">
        <h2>Privileged access</h2>
        <label className="check">
          <input type="checkbox" checked={pim.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Manage privileged roles with Privileged Identity Management
        </label>
      </header>
      <p className="muted">
        Instead of standing Owner or access-administrator assignments, named groups are <em>eligible</em> for privileged roles and
        activate them just in time, with MFA, a justification and (for the most powerful roles) approval. Every management group
        gets the same role settings, and nothing is assigned permanently. Needs Microsoft Entra ID P2 or Entra ID Governance.
      </p>

      {p && (
        <>
          <div className="row pim-profile">
            <label>
              Compliance profile
              <select value={pim.profile} onChange={(e) => set({ profile: e.target.value as PimInput['profile'] })}>
                <option value="auto">Automatic: {auto.profile === 'high' ? 'High' : 'Standard'}</option>
                <option value="standard">Standard</option>
                <option value="high">High</option>
              </select>
            </label>
            <span className="muted">{p.reason}</span>
          </div>

          <div className="table-scroll">
            <table className="pim-settings">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Standard</th>
                  <th>High</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Longest activation', (s) => duration(s.activationMaximumDuration)],
                    ['Activation requires', (s) => ['MFA', s.requireJustification && 'justification', s.requireTicket && 'ticket number'].filter(Boolean).join(', ')],
                    ['Approval for', (s) => PIM_ROLES.filter((r) => s.approvalRoles.includes(r.key)).map((r) => r.name).join(', ')],
                    ['Eligible assignments expire after', (s) => duration(s.eligibleExpireAfter)],
                    ['Active assignments expire after', (s) => `${duration(s.activeExpireAfter)} (no permanent assignments)`],
                    ['Access reviews (Entra ID)', (s) => s.accessReview],
                  ] as [string, (s: (typeof PROFILE_SETTINGS)['high']) => string][]
                ).map(([name, value]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    {(['standard', 'high'] as const).map((k) => (
                      <td key={k} className={p.profile === k ? 'current' : 'muted'}>
                        {value(PROFILE_SETTINGS[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Roles under PIM</h3>
          <div className="row">
            {PIM_ROLES.map((r) => (
              <label key={r.key} className="check" title={r.grantsAccess ? 'Can grant access to others' : undefined}>
                <input
                  type="checkbox"
                  checked={pim.roles.includes(r.key)}
                  onChange={(e) => set({ roles: e.target.checked ? [...pim.roles, r.key] : pim.roles.filter((k) => k !== r.key) })}
                />
                {r.name}
              </label>
            ))}
          </div>

          <h3>Eligible groups</h3>
          <p className="muted">Each group's Entra ID object ID is a per-environment value in Export IaC.</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Role</th>
                  <th>At</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pim.eligibilities.map((e) => {
                  const inDesign = p.eligibilities.some((x) => x.id === e.id);
                  return (
                    <tr key={e.id} className={inDesign ? '' : 'muted'}>
                      <td>{e.label}</td>
                      <td>{PIM_ROLES.find((r) => r.key === e.role)?.name}</td>
                      <td>
                        {mgName(e.mg)}
                        {!inDesign && <span className="badge warn">not in the design</span>}
                      </td>
                      <td className="actions">
                        <button className="link" onClick={() => set({ eligibilities: pim.eligibilities.filter((x) => x.id !== e.id) })}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row add-eligibility">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Group, e.g. Network administrators" />
            <select value={role} onChange={(e) => setRole(e.target.value as PimRoleKey)}>
              {PIM_ROLES.filter((r) => pim.roles.includes(r.key)).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
            <select value={mg} onChange={(e) => setMg(e.target.value as MgRole)}>
              {design.mgs.map((m) => (
                <option key={m.role} value={m.role}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <button onClick={addEligibility} disabled={!label.trim()}>
              Add eligible group
            </button>
          </div>

          {p.controls.length > 0 && (
            <>
              <h3>Controls this helps address</h3>
              <div className="pim-controls">
                {p.controls.map((c) => (
                  <div key={c.framework}>
                    <strong>{c.framework}</strong>
                    <ul>
                      {c.controls.map((x) => (
                        <li key={x.id}>
                          <code>{x.id}</code> {x.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="muted">
                PIM covers the technical side; the frameworks also expect the process: who approves, how often access is reviewed,
                and evidence of both.
              </p>
            </>
          )}

          <h3>Outside the export</h3>
          <ul className="muted pim-notes">
            <li>Keep two emergency access (break-glass) accounts outside PIM, excluded from Conditional Access, and monitor their use.</li>
            <li>Set up {p.settings.accessReview} access reviews of the eligible assignments in Entra ID (Identity Governance).</li>
            <li>Remove standing Owner and access-administrator assignments once the eligible ones work.</li>
            <li>Subscriptions keep their own PIM settings: the export sets them on the management groups, where the eligible groups are.</li>
            <li>Entra ID directory roles (such as Global Administrator) are managed in Entra ID PIM, not here.</li>
          </ul>
        </>
      )}
    </section>
  );
}
