import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import catalogJson from '../data/catalog.json';
import type { Catalog } from '../lib/catalog';
import { DEFAULT_INPUT, buildDesign } from '../lib/engine';
import { Coverage } from './Coverage';

const catalog = catalogJson as unknown as Catalog;

describe('Coverage view', () => {
  it('shows every status, including PIM and excluded manual controls', () => {
    const design = buildDesign(catalog, { ...DEFAULT_INPUT, excludeManualControls: true });
    const html = renderToString(<Coverage catalog={catalog} design={design} />);
    for (const label of ['Enforced', 'Audited', 'PIM', 'Excluded (manual)', 'No policy']) expect(html).toContain(label);
  });
});
