/**
 * Lazy loader for the optional image library `sharp`.
 *
 * `sharp` is only needed for image processing (resizing / converting photos before upload,
 * thumbnails, StoryBuilder). It is loaded on first use, so the rest of the library works on
 * platforms without a prebuilt `sharp` binary (for example Android / Termux).
 */
import * as Boom from '@hapi/boom';
import type SharpDefault from 'sharp';

export type Sharp = typeof SharpDefault;

let cached: Sharp | null = null;

/** Return the `sharp` function, or throw a Boom 424 error when it cannot be loaded. */
export function loadSharp(): Sharp {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('sharp');
    cached = (mod && mod.default ? mod.default : mod) as Sharp;
    return cached;
  } catch (e: any) {
    throw Boom.failedDependency(
      `Image processing requires the "sharp" package, which could not be loaded on ${process.platform}-${process.arch}. ` +
        'Everything else in insta-node-js works without it. To enable image processing on this platform, ' +
        'install the WebAssembly build: npm install @img/sharp-wasm32 (see https://sharp.pixelplumbing.com/install)',
      { code: 'DEPENDENCY_MISSING', dependency: 'sharp', cause: String(e?.message ?? e).split('\n')[0] },
    );
  }
}

/** True when `sharp` can be loaded on this platform. */
export function isSharpAvailable(): boolean {
  try {
    loadSharp();
    return true;
  } catch {
    return false;
  }
}
