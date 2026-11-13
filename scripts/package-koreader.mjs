import { readFileSync, writeFileSync } from 'node:fs';
import { buildZip } from '../dist/kindle-zip.js';

const files = ['_meta.lua', 'main.lua', 'sync.lua', 'annotations.lua', 'progress_hook.lua', 'cacert.pem', 'README.md'];
const entries = files.map(name => ({
  name: `crosspoint.koplugin/${name}`,
  data: readFileSync(new URL(`../koreader/crosspoint.koplugin/${name}`, import.meta.url)),
}));
entries.push({ name: 'crosspoint.koplugin/LICENSE', data: readFileSync(new URL('../LICENSE', import.meta.url)) });
writeFileSync(new URL('../dist/crosspoint-koreader.zip', import.meta.url), buildZip(entries));
console.log('Created dist/crosspoint-koreader.zip');
