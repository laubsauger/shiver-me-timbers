/**
 * WHERE THE STUDIO FARM PACKAGE IS: a sibling checkout of studio-farm beside this one (STUDIO_FARM_DIR, relative to
 * this checkout or absolute; default ../studio-farm). It is imported by path where it is used and is never a
 * package.json dependency: this repo is public and a fresh clone (or `npm ci` on a box) could not fetch it. Without
 * the checkout the farm is off (drift-dash says so; drift-slot --farm auto runs here) and the rest of the film works.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STUDIO_FARM_DIR = resolve(ROOT, process.env.STUDIO_FARM_DIR ?? '../studio-farm');
/** one of the package's modules, e.g. fromPackage('src/hub.mjs') */
export const fromPackage = (rel) => import(pathToFileURL(join(STUDIO_FARM_DIR, rel)).href);
