// Share a design as a link: the design itself, compressed into the URL's #
// fragment (never sent to a server). Only decisions that differ from the
// defaults are included, so links stay short.

import { DEFAULT_EXPORT_SETTINGS, migrateExportSettings, migrateInput } from './designs';
import { DEFAULT_INPUT, type DesignInput } from './engine';
import type { ExportSettings } from './iac';

const VERSION = '1';
export const SHARE_PARAM = 'design';

interface Payload {
  /** Decisions that differ from DEFAULT_INPUT. */
  i: Partial<DesignInput>;
  /** Export format and environment, and the values when asked for. */
  x?: Partial<ExportSettings>;
}

export interface SharedDesign {
  input: DesignInput;
  /** Present when the link carried export settings. */
  exportSettings?: ExportSettings;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Response(bytes).body!.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

/** The decisions that differ from the defaults. */
export function changedDecisions(input: DesignInput): Partial<DesignInput> {
  return Object.fromEntries(
    (Object.keys(input) as (keyof DesignInput)[])
      .filter((k) => JSON.stringify(input[k]) !== JSON.stringify(DEFAULT_INPUT[k]))
      .map((k) => [k, input[k]]),
  ) as Partial<DesignInput>;
}

/**
 * The fragment token for a design: "<version>.<z|j>.<base64url>", z for
 * deflate-compressed JSON, j for plain JSON where compression isn't available.
 */
export async function encodeDesign(
  input: DesignInput,
  exportSettings?: ExportSettings,
  options: { includeValues?: boolean; compress?: boolean } = {},
): Promise<string> {
  const payload: Payload = { i: changedDecisions(input) };
  if (exportSettings) {
    const { values, ...rest } = exportSettings;
    payload.x = options.includeValues && Object.keys(values).length ? { ...rest, values } : rest;
  }
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (options.compress !== false && canCompress())
    return `${VERSION}.z.${base64url(await transform(json, new CompressionStream('deflate-raw')))}`;
  return `${VERSION}.j.${base64url(json)}`;
}

/** Reads a token back into a design; throws a readable error for a broken link. */
export async function decodeDesign(token: string): Promise<SharedDesign> {
  const match = /^(\d+)\.([zj])\.([A-Za-z0-9_-]+)$/.exec(token.trim());
  if (!match) throw new Error("This link doesn't contain a design.");
  if (match[1] !== VERSION) throw new Error('This link was made by a newer version of the app.');
  let payload: Payload;
  try {
    let bytes = fromBase64url(match[3]);
    if (match[2] === 'z') {
      if (!canCompress()) throw new Error('compression');
      bytes = await transform(bytes, new DecompressionStream('deflate-raw'));
    }
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    if ((e as Error).message === 'compression') throw new Error("This browser can't open compressed design links.");
    throw new Error('This design link is damaged or incomplete; ask for it again.');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.i !== 'object') throw new Error("This link doesn't contain a design.");
  return {
    input: migrateInput(payload.i, payload.x as { excludeManualControls?: boolean } | undefined),
    ...(payload.x ? { exportSettings: migrateExportSettings({ ...DEFAULT_EXPORT_SETTINGS, ...payload.x }) } : {}),
  };
}

/** The page URL with the design in its fragment. */
export function shareUrl(pageUrl: string, token: string): string {
  return `${pageUrl.split('#')[0]}#${SHARE_PARAM}=${token}`;
}

/** The token in a URL fragment ("#design=..."), if any. */
export function tokenFromHash(hash: string): string | null {
  const m = new RegExp(`^#?${SHARE_PARAM}=(.+)$`).exec(hash);
  return m ? m[1] : null;
}
