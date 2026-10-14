import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS } from './designs';
import { DEFAULT_INPUT, type DesignInput } from './engine';
import { changedDecisions, decodeDesign, encodeDesign, shareUrl, tokenFromHash } from './share';

const design: DesignInput = {
  ...DEFAULT_INPUT,
  name: 'FedRAMP High – prod',
  frameworks: ['fedramp-high', 'nist-800-53-r5'],
  enforcement: 'strict',
  cloud: 'AzureUSGovernment',
  allowedLocations: ['usgovvirginia', 'usgovtexas'],
  overrides: { 'landingzones/Deny-IP-forwarding': { enforcementMode: 'DoNotEnforce', notScopes: [{ kind: 'managementGroup', role: 'online' }] } },
  exemptions: [
    { id: 'a', mg: 'landingzones', assignment: 'Deny-IP-forwarding', scope: { kind: 'subscription', id: '1111' }, policies: [], category: 'Waiver', reason: 'NVA "hub" & spokes', expiresOn: '2027-01-31' },
  ],
};
const settings = { ...DEFAULT_EXPORT_SETTINGS, format: 'terraform' as const, environment: 'gov', values: { platform_subscription_id: 'abc', pim_group_platform_owners: 'def' } };

describe('design links', () => {
  it('round-trips a design, compressed', async () => {
    const token = await encodeDesign(design, settings);
    expect(token).toMatch(/^1\.z\.[A-Za-z0-9_-]+$/);
    const shared = await decodeDesign(token);
    expect(shared.input).toEqual(design);
    expect(shared.exportSettings).toMatchObject({ format: 'terraform', environment: 'gov' });
  });

  it('leaves the environment values out unless asked', async () => {
    expect((await decodeDesign(await encodeDesign(design, settings))).exportSettings!.values).toEqual({});
    expect((await decodeDesign(await encodeDesign(design, settings, { includeValues: true }))).exportSettings!.values).toEqual(settings.values);
  });

  it('keeps links short by carrying only what differs from the defaults', async () => {
    expect(changedDecisions(DEFAULT_INPUT)).toEqual({});
    expect(Object.keys(changedDecisions(design)).sort()).toEqual(
      ['allowedLocations', 'cloud', 'enforcement', 'exemptions', 'frameworks', 'name', 'overrides'].sort(),
    );
    expect((await encodeDesign(DEFAULT_INPUT)).length).toBeLessThan(20);
    expect((await encodeDesign(design, settings)).length).toBeLessThan(800);
    expect(await decodeDesign(await encodeDesign(DEFAULT_INPUT))).toEqual({ input: DEFAULT_INPUT });
  });

  it('also reads uncompressed links', async () => {
    const token = await encodeDesign(design, undefined, { compress: false });
    expect(token.startsWith('1.j.')).toBe(true);
    expect((await decodeDesign(token)).input).toEqual(design);
  });

  it('explains broken links', async () => {
    await expect(decodeDesign('hello')).rejects.toThrow(/doesn't contain a design/);
    await expect(decodeDesign('2.z.abc')).rejects.toThrow(/newer version/);
    const token = await encodeDesign(design);
    await expect(decodeDesign(token.slice(0, -12))).rejects.toThrow(/damaged or incomplete/);
  });

  it('puts the token in the fragment and reads it back', async () => {
    const token = await encodeDesign(design);
    const url = shareUrl('https://example.net/app/?x=1#old', token);
    expect(url).toBe(`https://example.net/app/?x=1#design=${token}`);
    expect(tokenFromHash(new URL(url).hash)).toBe(token);
    expect(tokenFromHash('#other')).toBeNull();
  });
});
