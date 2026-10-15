// @vitest-environment jsdom
// The app in a browser-like DOM, driven the way a user would drive it.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import catalogJson from './data/catalog.json';
import { designBaseline } from './lib/baseline';
import type { Catalog } from './lib/catalog';
import { DEFAULT_EXPORT_SETTINGS, createDesign } from './lib/designs';
import { DEFAULT_INPUT, buildDesign } from './lib/engine';
import { STORAGE_KEYS, loadInput } from './lib/storage';
import { complianceFixture, fixture } from './test/azureFixture';
import { allByText, blur, byText, click, field, mount, setValue, unmountAll, until } from './test/dom';

const catalog = catalogJson as unknown as Catalog;
const app = () => mount(<App />);
/** Serves the app's lazily fetched files from public/. */
const stubFetch = () =>
  vi.stubGlobal('fetch', async (url: string) => {
    const name = String(url).split('/').pop()!;
    return new Response(readFileSync(`public/${name}`, 'utf8'), { headers: { 'content-type': 'application/json' } });
  });
/** The decisions panel's section with this heading. */
const section = (root: ParentNode, title: string) => byText(root, 'section.decision', title).closest('section')!;
const tab = (root: ParentNode, label: string | RegExp) => byText<HTMLButtonElement>(root, '.tabs button', label);

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the app', () => {
  it('opens every view', () => {
    const c = app();
    click(tab(c, 'Control coverage'));
    expect(c.textContent).toContain('No policy');
    click(tab(c, 'Policies'));
    expect(byText(c, 'h2', 'Policies')).toBeTruthy();
    click(tab(c, 'Privileged access'));
    expect(byText(c, 'h2', 'Privileged access')).toBeTruthy();
    click(tab(c, 'Compare'));
    expect(byText(c, 'h2', 'Compare')).toBeTruthy();
    click(tab(c, 'Management groups'));
    expect(c.querySelectorAll('.mg-node').length).toBeGreaterThan(5);
    expect(localStorage.getItem(STORAGE_KEYS.view)).toBe('"hierarchy"');
  });

  it('picks Defender plans under the Defender guardrail', () => {
    const c = app();
    const plans = section(c, 'Defender plans');
    expect(field(plans, 'Defender CSPM').checked).toBe(false);
    click(field(plans, /^Servers$/));
    click(field(plans, 'Defender CSPM'));
    expect(loadInput().defenderPlans).toContain('Cspm');
    expect(loadInput().defenderPlans).not.toContain('Servers');

    click(field(section(c, 'Guardrails'), 'Defender for Cloud'));
    expect(allByText(c, 'section.decision h3', 'Defender plans')).toHaveLength(0);
  });

  it('swaps the regions when switching cloud', () => {
    const c = app();
    setValue(field(c, 'Cloud'), 'AzureUSGovernment');
    expect(loadInput()).toMatchObject({ cloud: 'AzureUSGovernment', allowedLocations: ['usgovvirginia', 'usgovtexas'] });
    setValue(field(c, 'Cloud'), 'AzureCloud');
    expect(loadInput().allowedLocations).toEqual(['eastus2', 'centralus']);
  });
});

describe('management groups', () => {
  const open = (c: HTMLElement, name: string) => click(byText(c, 'button.mg-node', name));

  it('lists assignments inherited from parents, and opens the parent they are made at', () => {
    const c = app();
    open(c, 'Corp');
    click(tab(c, /^Inherited/));
    const rows = c.querySelectorAll('tr.assignment');
    expect(rows.length).toBeGreaterThan(10);
    expect(c.querySelectorAll('tr.assignment.inherited')).toHaveLength(rows.length);

    setValue(byText(c, 'label', 'From').querySelector('select')!, 'landingzones');
    const fromLandingZones = c.querySelectorAll('tr.assignment').length;
    expect(fromLandingZones).toBeGreaterThan(0);
    expect(fromLandingZones).toBeLessThan(rows.length);

    click(c.querySelector('tr.assignment button[title^="Open this group"]')!);
    expect(c.querySelector('main h2')!.textContent).toBe('Landing zones');
  });

  it('overrides an assignment and adds an exemption', () => {
    const c = app();
    open(c, 'Landing zones');
    click(byText(c, 'tr.assignment', 'Deny-IP-forwarding'));
    const detail = c.querySelector('tr.assignment-detail')!;

    setValue(field(detail, 'Enforcement'), 'DoNotEnforce');
    expect(loadInput().overrides['landingzones/Deny-IP-forwarding']).toEqual({ enforcementMode: 'DoNotEnforce' });
    expect(byText(c, 'tr.assignment', 'Deny-IP-forwarding').textContent).toContain('Overridden');

    const params = field<HTMLTextAreaElement>(c, 'Parameter overrides');
    setValue(params, '{ not json');
    blur(params);
    expect(c.textContent).toContain('Parameters must be a JSON object');

    click(byText(c, 'button', 'Add exemption'));
    expect(c.textContent).toContain('Give a reason');
    setValue(c.querySelector('input[placeholder="Reason (required)"]')!, 'NVA in the hub');
    click(byText(c, 'button', 'Add exemption'));
    expect(loadInput().exemptions).toMatchObject([{ mg: 'landingzones', assignment: 'Deny-IP-forwarding', reason: 'NVA in the hub', policies: [] }]);
    expect(byText(c, '.exemptions li', 'Whole assignment').textContent).toContain('NVA in the hub');
  });
});

describe('designs', () => {
  it('saves, notices changes, duplicates and deletes', () => {
    const c = app();
    const chip = () => c.querySelector('.save-chip')!.textContent;
    expect(chip()).toBe('not saved');

    click(byText(c, '.topbar button', /^Designs/));
    const dialog = () => c.querySelector('[role="dialog"][aria-label="Designs"]')!;
    click(byText(dialog(), 'button', /^Save( design)?$/));
    expect(chip()).toBe('✓ saved');

    setValue(c.querySelector('.design-title')!, 'Renamed');
    expect(chip()).toBe('● unsaved changes');

    click(byText(dialog(), 'tr button', 'Duplicate'));
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(2);
    click(dialog().querySelectorAll<HTMLButtonElement>('tbody tr button.danger')[1]);
    expect(dialog().querySelectorAll('tbody tr')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.designs)!)).toHaveLength(1);
  });
});

describe('privileged access', () => {
  it('adds an eligible group', () => {
    const c = app();
    click(tab(c, 'Privileged access'));
    setValue(c.querySelector('input[placeholder^="Group, e.g."]')!, 'Firewall admins');
    click(byText(c, 'button', 'Add eligible group'));
    expect(byText(c, 'tr', 'Firewall admins')).toBeTruthy();
    expect(loadInput().pim.eligibilities.some((e) => e.label === 'Firewall admins')).toBe(true);
  });
});

describe('design links', () => {
  it('shares a design and opens it from the link', async () => {
    let c = app();
    setValue(c.querySelector('.design-title')!, 'Shared design');
    click(byText(c, '.topbar button', /^Share$/));
    const link = await until(() => c.querySelector<HTMLInputElement>('input[aria-label="Design link"]')?.value.includes('#design=') && c.querySelector<HTMLInputElement>('input[aria-label="Design link"]')!.value);
    const hash = new URL(link).hash;

    unmountAll();
    localStorage.clear();
    window.history.replaceState(null, '', `/${hash}`);
    c = app();
    await until(() => c.textContent!.includes('Opened the shared design "Shared design"'));
    expect(c.querySelector<HTMLInputElement>('.design-title')!.value).toBe('Shared design');
    expect(window.location.hash).toBe('');
  });

  it('explains a damaged link', async () => {
    window.history.replaceState(null, '', '/#design=1.z.AAAA');
    const c = app();
    await until(() => c.textContent!.includes("Couldn't open the design link"));
  });
});

describe('export and report', () => {
  it('exports Bicep and Terraform', async () => {
    const library = readFileSync('public/alz-library.json', 'utf8');
    vi.stubGlobal('fetch', async () => new Response(library, { headers: { 'content-type': 'application/json' } }));
    const c = app();
    click(byText(c, '.topbar button', 'Export IaC'));
    const dialog = c.querySelector('[role="dialog"][aria-label="Export IaC"]')!;
    await until(() => dialog.querySelector('.file-tabs'));
    expect(byText(dialog, '.file-tabs button', 'main.bicep')).toBeTruthy();
    click(byText(dialog, '.tabs button', 'Terraform'));
    click(byText(dialog, '.file-tabs button', 'main.tf'));
    expect(dialog.querySelector('pre, code, textarea')!.textContent).toContain('azurerm');
  });

  it('downloads the compliance report as a workbook', async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), 'blob:report'));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const c = app();
    click(byText(c, '.topbar button', 'Compliance report'));
    expect(blob!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect((await blob!.text()).slice(0, 2)).toBe('PK');
  });
});

describe('compare', () => {
  it('imports from Azure and compares it with the design', () => {
    const c = app();
    click(tab(c, 'Compare'));
    click(byText(c, 'button', 'Import from Azure…'));
    const dialog = c.querySelector('[role="dialog"][aria-label="Import from Azure"]')!;
    setValue(dialog.querySelector('textarea')!, fixture());
    expect(byText(dialog, 'li.ok', 'policy assignments')).toBeTruthy();
    click(byText(dialog, 'button', 'Import and compare'));

    expect(c.querySelector('[role="dialog"]')).toBeNull();
    const sides = [...c.querySelectorAll<HTMLSelectElement>('.compare-sides select')].map((s) => s.value);
    expect(sides).toEqual(['current', 'azure:0']);

    click(c.querySelector('.venn [aria-label^="both:"]')!);
    expect(tab(c, /^In both/).className).toContain('active');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.azureImports)!)).toHaveLength(1);
  });
});

describe('custom assignments', () => {
  it('adds any built-in policy to a management group, and deletes it again', async () => {
    stubFetch();
    const c = app();
    click(byText(c, 'button.mg-node', 'Corp'));
    click(byText(c, 'button', '+ Add an assignment'));
    // Only the full policy index has this one, so it shows once the index loads.
    setValue(c.querySelector('input[aria-label="Search definitions"]')!, 'Arc enabled Kubernetes clusters to install the Azure Policy extension');
    const result = await until(() => allByText<HTMLButtonElement>(c, '.definition-results button', 'Configure Azure Arc enabled Kubernetes clusters to install the Azure Policy extension')[0]);
    click(result);
    setValue(c.querySelector('input[aria-label="Assignment name"]')!, 'Deploy-Arc-Policy');
    click(byText(c, 'button', /^Add assignment$/));

    expect(loadInput().customAssignments).toMatchObject([{ mg: 'corp', name: 'Deploy-Arc-Policy', kind: 'policy', definition: '0adc5395-9169-4b9b-8687-af838d69410a' }]);
    const row = byText(c, 'tr.assignment', 'Deploy-Arc-Policy');
    expect(row.textContent).toContain('Custom');
    click(row);
    click(byText(c, 'button', 'Delete custom assignment'));
    expect(loadInput().customAssignments).toEqual([]);
    expect(allByText(c, 'tr.assignment', 'Deploy-Arc-Policy')).toHaveLength(0);
  });

  it('adds any built-in initiative, with its policies', async () => {
    stubFetch();
    const c = app();
    click(byText(c, 'button.mg-node', 'Landing zones'));
    click(byText(c, 'button', '+ Add an assignment'));
    click(byText(c, '[aria-label="Definition kind"] button', 'Built-in initiative'));
    setValue(c.querySelector('input[aria-label="Search definitions"]')!, 'Linux machines to run Azure Monitor Agent and associate them to a Data Collection Rule');
    // Not a catalog initiative, so it shows once the initiative index loads.
    const result = await until(() => allByText<HTMLButtonElement>(c, '.definition-results button', /^Configure Linux machines to run Azure Monitor Agent and associate them to a Data Collection Rule$/)[0]);
    click(result);
    await until(() => !c.textContent!.includes('Loading every built-in policy'));
    setValue(c.querySelector('input[aria-label="Assignment name"]')!, 'Deploy-AMA-Linux');
    click(byText(c, 'button', /^Add assignment$/));

    const [added] = loadInput().customAssignments;
    expect(added).toMatchObject({ mg: 'landingzones', kind: 'initiative', definition: '118f04da-0375-44d1-84e3-0fd9e1849403' });
    expect(added.members!.length).toBeGreaterThan(1);
    expect(Object.keys(added.infos ?? {}).length).toBeGreaterThan(0);
    expect(byText(c, 'tr.assignment', 'Deploy-AMA-Linux').textContent).toContain(String(added.members!.length));
  });

  it('checks the name', async () => {
    stubFetch();
    const c = app();
    click(byText(c, 'button.mg-node', 'Landing zones'));
    click(byText(c, 'button', '+ Add an assignment'));
    await until(() => !c.textContent!.includes('Loading every built-in policy'));
    setValue(c.querySelector('input[aria-label="Search definitions"]')!, 'allowed virtual machine size SKUs');
    click(byText(c, '.definition-results button', 'Allowed virtual machine size SKUs'));
    setValue(c.querySelector('input[aria-label="Assignment name"]')!, 'Deny-IP-forwarding');
    click(byText(c, 'button', /^Add assignment$/));
    expect(c.textContent).toContain('Landing zones already has an assignment named Deny-IP-forwarding.');
    expect(loadInput().customAssignments).toEqual([]);
  });
});

describe('cost', () => {
  it('estimates the running cost from the counts entered', () => {
    const c = app();
    click(tab(c, 'Cost'));
    const total = () => c.querySelector('.cost-total strong')!.textContent;
    const before = total();
    setValue(field(c, 'Servers (VMs and Arc machines)'), '100');
    expect(loadInput().costQuantities.servers).toBe(100);
    expect(total()).not.toBe(before);
    const servers = [...c.querySelectorAll('.cost-table tr')].find((tr) => tr.querySelector('td')?.textContent === 'Servers')!;
    expect(servers.textContent).toContain('100 servers');
    expect(servers.textContent).toContain('$1,500');
    expect(c.querySelector('.cost-table')!.textContent).not.toMatch(/RU\/ss|GBs/);
    expect(c.querySelector('.stats')!.textContent).toContain(total()!);
  });
});

describe('migration plan', () => {
  it('plans from an Azure import with compliance state, and exports the audit-first phase', async () => {
    stubFetch();
    const c = app();
    click(tab(c, 'Compare'));
    click(byText(c, 'button', 'Import from Azure…'));
    const dialog = c.querySelector('[role="dialog"][aria-label="Import from Azure"]')!;
    setValue(dialog.querySelector('textarea')!, fixture() + complianceFixture());
    click(byText(dialog, 'button', 'Import and compare'));

    expect(byText(c, 'h3', 'Compliance in Azure: Azure')).toBeTruthy();
    const plan = byText(c, 'section.migration', 'Migration plan');
    expect(plan.textContent).toContain('5. Clean up');
    expect(byText(plan, '.migration-steps li', 'Remove').textContent).toContain('az policy assignment delete');

    // The compliance report can include this import's compliance state.
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), 'blob:report'));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    click(byText(c, 'button', 'Compliance report with this import (.xlsx)'));
    expect(await blob!.text()).toContain('Compliance in Azure');
    expect(byText(c, '.topbar button', 'Compliance report').title).toMatch(/with the compliance in Azure from "Azure[^"]*"/);

    click(byText(plan, 'button', 'Export phases 1–2 (audit first)'));
    const exp = c.querySelector('[role="dialog"][aria-label="Export IaC"]')!;
    expect(exp.querySelector('h2')!.textContent).toBe('Export migration phases 1–2: audit first');
    await until(() => exp.querySelector('.file-tabs'));
    expect(byText(exp, '.file-tabs button', 'MIGRATION.md')).toBeTruthy();
    click(byText(exp, '.tabs button', 'Terraform'));
    click(byText(exp, '.file-tabs button', 'imports.tf'));
    expect(exp.querySelector('pre, code, textarea')!.textContent).toContain('azurerm_management_group.level_1["contoso"]');
  });
});

describe('saved designs after a catalog update', () => {
  it('shows what a saved design now deploys differently, until reviewed', () => {
    const saved = createDesign({ ...DEFAULT_INPUT, name: 'Older design' }, DEFAULT_EXPORT_SETTINGS);
    const baseline = designBaseline(catalog, buildDesign(catalog, saved.input));
    // As if saved before a catalog update that added an assignment.
    const [first] = Object.keys(baseline.assignments);
    delete baseline.assignments[first];
    localStorage.setItem(STORAGE_KEYS.designs, JSON.stringify([{ ...saved, baseline: { ...baseline, catalog: '2026-01-01' } }]));

    const c = app();
    click(byText(c, '.topbar button', /^Designs/));
    const dialog = c.querySelector('[role="dialog"][aria-label="Designs"]')!;
    const row = [...dialog.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('input')?.value === 'Older design')!;
    expect(row.textContent).toContain('changed since saved');
    click(byText(row, 'button', 'Open'));

    const notice = byText(c, '.design-changes', 'deploys differently');
    expect(notice.textContent).toContain('1 assignment added');
    click(byText(notice, 'button', 'Mark as reviewed'));
    expect(c.querySelector('.design-changes')).toBeNull();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.designs)!)[0];
    expect(Object.keys(stored.baseline.assignments)).toContain(first);
  });
});
