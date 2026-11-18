/**
 * Recognising translation engine code (translation tier; no DOM, works in node for tests).
 * A zip that carries a translation engine holds JavaScript and WebAssembly that the page runs inside a worker, so only the engine published
 * with the project is accepted: an unknown engine is refused when the zip is added (`identifyPack`) and again when the worker starts
 * (`assertKnownEngine`, which covers a zip stored before the check existed). Model files are data, never run as code, so model-only zips are not checked.
 * The check is by content: the SHA-256 of the three engine files the manifest names must be the known ones, whatever the zip or its manifest
 * says about itself. Known: the Bergamot engine published with the project's own packs. To accept another build, add its hashes here.
 */
import JSZip from 'jszip';
import type { EngineSpec, TlManifest } from './pack';

/** the known SHA-256 of each engine file, by role: a known file in the wrong role is not accepted */
const ENGINE = {
  worker: '90257af9ee0758983501bdce77ca7ec168cd7360d4689298c20a81b0251d6b62', // translator-worker.js
  glue: '748b2418418a2ffc6e70721aeb10098d8e6fb589ea156b91f4ae8bc3490d8f7a', // bergamot-translator-worker.js
  wasm: '95a2b58dd6773bf1b3f345d71f9149928b9f75f4ec9c9064c0b3e42c298671b2', // bergamot-translator-worker.wasm
} as const;
const ROLES = ['worker', 'glue', 'wasm'] as const;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (z: JSZip, path: string) =>
  hex(await crypto.subtle.digest('SHA-256', await z.file(path)!.async('arraybuffer')));

/** shown to the user when an engine zip is refused */
export const ENGINE_REFUSED =
  'This zip carries a translation engine that is not the one published with this project, so it was not used. Only that engine is accepted, because an engine is program code that runs in the browser.';

export interface PackVerdict {
  /** true when there is no engine code in the zip, or it is the known engine */
  recognised: boolean;
  /** why the zip is refused; '' when recognised */
  notice: string;
}

/** throws when any of the three engine files in `z` is not a known one (the engine is never started from files that fail this) */
export async function assertKnownEngine(z: JSZip, spec: EngineSpec): Promise<void> {
  for (const r of ROLES) {
    if (!z.file(spec[r]) || (await sha256(z, spec[r])) !== ENGINE[r]) throw new Error(ENGINE_REFUSED);
  }
}

/** `manifest` must already have passed `readManifest` (every named file exists in the zip) */
export async function identifyPack(data: Blob | Uint8Array, manifest: TlManifest): Promise<PackVerdict> {
  if (!manifest.engine) return { recognised: true, notice: '' };
  try {
    await assertKnownEngine(await JSZip.loadAsync(data), manifest.engine);
    return { recognised: true, notice: '' };
  } catch {
    // fall through: unreadable zip or unknown files
  }
  return { recognised: false, notice: ENGINE_REFUSED };
}
