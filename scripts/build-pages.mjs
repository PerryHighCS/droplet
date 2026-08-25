import {cp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const output = resolve(root, 'site');

export async function buildPages() {
  const copy = (from, to) => cp(resolve(root, from), resolve(output, to), {recursive: true, dereference: true});
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  await copy('pages', '.');
  await copy('packages/core/src', 'modules/core');
  await copy('packages/codemirror-editor/src', 'modules/codemirror-editor');
  await copy('packages/editor/src', 'modules/editor');
  await copy('packages/javascript-adapter/src', 'modules/javascript');
  await copy('packages/python-adapter/src', 'modules/python');

  for (const dependency of [
    '@codemirror', '@lezer', '@marijn', 'crelt', 'style-mod', 'w3c-keyname'
  ]) {
    await copy(`packages/editor/node_modules/${dependency}`, `vendor/${dependency}`);
  }
  await copy('packages/javascript-adapter/node_modules/acorn', 'vendor/acorn');
  await copy('playwright/node_modules/brython/brython.js', 'vendor/brython.js');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPages();
