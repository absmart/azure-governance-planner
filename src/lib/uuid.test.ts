import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { URL_NAMESPACE, uuidv5 } from './uuid';

/** Reference UUID v5 with Node's SHA-1. */
function reference(name: string, namespace = URL_NAMESPACE): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('uuidv5', () => {
  it('matches the RFC 4122 test vector', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('matches a SHA-1 reference for names of every block length', () => {
    for (const name of ['', 'a', 'contoso/Network-Management', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'é'.repeat(100)])
      expect(uuidv5(name)).toBe(reference(name));
  });
});
