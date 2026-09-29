import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NOW = new Date(2026, 8, 28, 10, 0); // Monday, Sep 28 2026, 10:00 local

export function loadFixture(name, url = `https://school.example.edu/${name}`) {
  const html = readFileSync(path.join(root, 'tests/fixtures/school-site', name), 'utf8');
  return new JSDOM(html, { url }).window.document;
}
