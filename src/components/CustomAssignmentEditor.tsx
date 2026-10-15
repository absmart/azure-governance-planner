import { useEffect, useMemo, useState } from 'react';
import { portalInitiativeUrl, portalPolicyUrl, type Catalog, type PolicyInfo } from '../lib/catalog';
import {
  assignmentName,
  knownInitiatives,
  overrideKey,
  type CustomAssignment,
  type DesignInput,
  type PlannedMg,
} from '../lib/engine';
import catalogJson from '../data/catalog.json';
import {
  initiativeMembers,
  loadInitiativeIndex,
  loadPolicyIndex,
  searchInitiatives,
  searchPolicies,
  type IndexedInitiative,
  type InitiativeIndex,
  type PolicyIndex,
} from '../lib/policyIndex';

/** The catalog as shipped: a custom assignment stores the details of policies it doesn't carry. */
const baseCatalog = catalogJson as unknown as Catalog;

interface Result {
  id: string;
  name: string;
  detail: string;
  info?: PolicyInfo;
  /** An initiative from the initiative index (not one the catalog knows). */
  indexed?: IndexedInitiative;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,23}$/;
let customSeq = 0;

/** Adds an assignment of any built-in policy or initiative to a management group. */
export function AddAssignment(props: { catalog: Catalog; mg: PlannedMg; input: DesignInput; onChange: (input: DesignInput) => void }) {
  const { catalog, mg, input, onChange } = props;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'policy' | 'initiative'>('policy');
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<PolicyIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [initiativeIndex, setInitiativeIndex] = useState<InitiativeIndex | null>(null);
  const [picked, setPicked] = useState<Result | null>(null);
  const [name, setName] = useState('');
  const [effect, setEffect] = useState('');
  const [enforcementMode, setEnforcementMode] = useState<CustomAssignment['enforcementMode']>('Default');
  const [params, setParams] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || index) return;
    let current = true;
    loadPolicyIndex()
      .then((i) => current && setIndex(i))
      .catch((e: Error) => current && setIndexError(e.message));
    return () => {
      current = false;
    };
  }, [open, index]);

  useEffect(() => {
    if (!open || kind !== 'initiative' || initiativeIndex) return;
    let current = true;
    loadInitiativeIndex()
      .then((i) => current && setInitiativeIndex(i))
      .catch((e: Error) => current && setIndexError(e.message));
    return () => {
      current = false;
    };
  }, [open, kind, initiativeIndex]);

  const initiatives = useMemo(() => knownInitiatives(catalog), [catalog]);
  const q = query.trim().toLowerCase();
  const known = new Set(initiatives.map((i) => i.id.toLowerCase()));
  const results: Result[] =
    kind === 'policy'
      ? searchPolicies(catalog, index, query).map((r) => ({ id: r.id, name: r.info.n, detail: `${r.info.c} · ${r.info.e}${r.info.dp ? ' · deprecated' : ''}`, info: r.info }))
      : [
          ...initiatives
            .filter((i) => q && q.split(/\s+/).every((w) => `${i.name} ${i.id}`.toLowerCase().includes(w)))
            .map((i) => ({ id: i.id, name: i.name, detail: `${i.policies.length} policies` })),
          ...searchInitiatives(initiativeIndex, query)
            .filter((r) => !known.has(r.id.toLowerCase()))
            .map((r) => ({ id: r.id, name: r.initiative.n, detail: `${r.initiative.c} · ${new Set(r.initiative.m.map((m) => m[0])).size} policies`, indexed: r.initiative })),
        ]
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 50);

  const reset = () => {
    setPicked(null);
    setQuery('');
    setName('');
    setEffect('');
    setParams('');
    setEnforcementMode('Default');
    setError(null);
  };

  const pick = (r: Result) => {
    setPicked(r);
    setName(assignmentName(r.name));
    setEffect('');
    setError(null);
  };

  const add = () => {
    if (!picked) return;
    if (!NAME.test(name)) return setError('The name is 1-24 letters, digits and hyphens, starting with a letter or digit.');
    if (mg.assignments.some((a) => a.name.toLowerCase() === name.toLowerCase()))
      return setError(`${mg.displayName} already has an assignment named ${name}.`);
    let parameters: Record<string, unknown> = {};
    if (params.trim()) {
      try {
        parameters = JSON.parse(params);
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error();
      } catch {
        return setError('Parameters must be a JSON object, for example { "listOfAllowedSKUs": ["Standard_D2s_v5"] }.');
      }
    }
    if (effect) parameters = { ...parameters, effect };
    if (picked.indexed && !index) return setError('Still loading the policy list; try again in a moment.');
    const fromIndex = picked.indexed ? initiativeMembers(baseCatalog, index, picked.indexed) : null;
    const custom: CustomAssignment = {
      id: `${Date.now().toString(36)}${(customSeq++).toString(36)}`,
      mg: mg.role,
      name,
      displayName: picked.name,
      kind,
      definition: picked.id,
      ...(picked.info ? { info: picked.info } : {}),
      ...(fromIndex ? { members: fromIndex.members, ...(Object.keys(fromIndex.infos).length ? { infos: fromIndex.infos } : {}) } : {}),
      enforcementMode,
      parameters,
    };
    onChange({ ...input, customAssignments: [...(input.customAssignments ?? []), custom] });
    reset();
    setOpen(false);
  };

  if (!open)
    return (
      <button className="add-assignment" onClick={() => setOpen(true)}>
        + Add an assignment
      </button>
    );

  const info = picked?.info;
  return (
    <div className="editor add-assignment-editor">
      <h4>Add an assignment to {mg.displayName}</h4>
      {!picked ? (
        <>
          <div className="row">
            <div className="tabs" role="tablist" aria-label="Definition kind">
              {(['policy', 'initiative'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                  {k === 'policy' ? 'Built-in policy' : 'Built-in initiative'}
                </button>
              ))}
            </div>
            <input
              className="wide"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={kind === 'policy' ? 'Search by name, category or GUID, e.g. allowed virtual machine SKUs' : 'Search initiatives by name or GUID'}
              aria-label="Search definitions"
            />
            <button
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
          {kind === 'policy' && !index && !indexError && <p className="muted">Loading every built-in policy… (searching the catalog's meanwhile)</p>}
          {indexError && <p className="error-text">Couldn't load the full policy list ({indexError}); searching the catalog's policies only.</p>}
          {kind === 'initiative' && !initiativeIndex && !indexError && <p className="muted">Loading every built-in initiative… (searching the catalog's meanwhile)</p>}
          {kind === 'initiative' && (
            <p className="muted">Coverage counts an initiative's policies with their default effects; set its parameters below to change what it deploys.</p>
          )}
          {results.length > 0 && (
            <ul className="definition-results">
              {results.map((r) => (
                <li key={r.id}>
                  <button className="link" onClick={() => pick(r)}>
                    {r.name}
                  </button>{' '}
                  <span className="muted">{r.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {q && !results.length && <p className="muted">No matches.</p>}
        </>
      ) : (
        <>
          <p>
            <strong>{picked.name}</strong>{' '}
            <a href={kind === 'policy' ? portalPolicyUrl(picked.id) : portalInitiativeUrl(picked.id)} target="_blank" rel="noreferrer">
              definition and parameters ↗
            </a>{' '}
            <button className="link" onClick={() => setPicked(null)}>
              Change
            </button>
          </p>
          {info?.d && <p className="muted">{info.d}</p>}
          <div className="row">
            <label>
              Name
              <input className="mono" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} aria-label="Assignment name" />
            </label>
            {info && info.a.length > 1 && (
              <label title="Sets the policy's effect parameter">
                Effect
                <select value={effect} onChange={(e) => setEffect(e.target.value)}>
                  <option value="">Default ({info.e})</option>
                  {info.a.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Enforcement
              <select value={enforcementMode} onChange={(e) => setEnforcementMode(e.target.value as CustomAssignment['enforcementMode'])}>
                <option value="Default">Enforce (Default)</option>
                <option value="DoNotEnforce">DoNotEnforce (report only)</option>
              </select>
            </label>
          </div>
          <label className="field">
            Parameters (JSON; required ones without a default must be set, see the definition)
            <textarea rows={3} className="mono" value={params} onChange={(e) => setParams(e.target.value)} placeholder='{ "listOfAllowedSKUs": ["Standard_D2s_v5"] }' />
          </label>
          <div className="row">
            <button className="primary" onClick={add}>
              Add assignment
            </button>
            <button
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** Takes a custom assignment out of the design. */
export function RemoveCustomAssignment(props: { mg: PlannedMg; name: string; input: DesignInput; onChange: (input: DesignInput) => void }) {
  const { mg, name, input, onChange } = props;
  return (
    <div className="editor">
      <h4>Custom assignment</h4>
      <p className="muted">Added by hand. Change its enforcement or parameters with the override above, or delete it.</p>
      <button
        className="danger"
        onClick={() => {
          // Its overrides and exemptions go with it.
          const overrides = { ...input.overrides };
          delete overrides[overrideKey(mg.role, name)];
          onChange({
            ...input,
            customAssignments: input.customAssignments.filter((c) => !(c.mg === mg.role && c.name === name)),
            overrides,
            exemptions: input.exemptions.filter((e) => !(e.mg === mg.role && e.assignment === name)),
          });
        }}
      >
        Delete custom assignment
      </button>
    </div>
  );
}
