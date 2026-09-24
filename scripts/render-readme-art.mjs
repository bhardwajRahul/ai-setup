#!/usr/bin/env node
// Renders the README art in assets/readme/src/art.html to assets/readme/*.
// The owl and the clay icons come from the caliber-lp repo, so point this at
// a local checkout of it:
//
//   node scripts/render-readme-art.mjs --lp ../caliber-lp
//
// Needs Playwright with Chromium (`npm i -g playwright` works) and network
// access to Google Fonts for Fraunces, Inter and Geist Mono (fetched here
// and inlined into the page).
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lpArg = process.argv.indexOf('--lp');
const lp = resolve(lpArg > -1 ? process.argv[lpArg + 1] : join(root, '..', 'caliber-lp'));

const srcDir = join(root, 'assets/readme/src');
const outDir = join(root, 'assets/readme');
let html = readFileSync(join(srcDir, 'art.html'), 'utf8').replaceAll(
  '{{LP}}',
  pathToFileURL(join(lp, 'public/solution')).href,
);

// Fetch the Google Fonts stylesheet and its files from Node and inline them,
// so the render does not depend on the browser's certificate store.
const fontLink = html.match(
  /<link href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)" rel="stylesheet">/,
);
if (fontLink) {
  const UA = {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  };
  let css = await (await fetch(fontLink[1].replaceAll('&amp;', '&'), { headers: UA })).text();
  for (const url of new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) ?? [])) {
    const bytes = Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
    css = css.replaceAll(url, `data:application/octet-stream;base64,${bytes.toString('base64')}`);
  }
  html = html.replace(fontLink[0], `<style>${css}</style>`);
}
const tmp = join(srcDir, '.art.rendered.html');
writeFileSync(tmp, html);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const globalRoot = process.env.NODE_PATH ?? '/usr/local/lib/node_modules';
  ({ chromium } = createRequire(join(globalRoot, 'noop.js'))('playwright'));
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1200 },
    deviceScaleFactor: 2,
  });
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  for (const frame of await page.$$('section[data-frame]')) {
    const name = await frame.getAttribute('data-frame');
    const type = (await frame.getAttribute('data-type')) ?? 'png';
    const path = join(outDir, `${name}.${type === 'jpeg' ? 'jpg' : 'png'}`);
    await frame.screenshot({
      path,
      type,
      ...(type === 'jpeg' ? { quality: 84 } : { omitBackground: true }),
    });
    console.log(`wrote ${path}`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { force: true });
}
