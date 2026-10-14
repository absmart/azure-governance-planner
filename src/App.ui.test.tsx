// @vitest-environment jsdom
// The app in a browser-like DOM, driven the way a user would drive it.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { STORAGE_KEYS, loadInput } from './lib/storage';
import { fixture } from './test/azureFixture';
import { allByText, blur, byText, click, field, mount, setValue, unmountAll, until } from './test/dom';

const app = () => mount(<App />);
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
