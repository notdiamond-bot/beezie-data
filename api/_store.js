// A file-backed stand-in for the site's key/value store, so the counting code in
// _stats.js and _pulls.js runs here unchanged. Each key is one JSON file in kv/;
// the files are committed, so what has been counted is kept for good.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('../kv/', import.meta.url);
mkdirSync(DIR, { recursive: true });

export const backend = 'file';
export const kvHealthy = () => true;

const fileFor = (key) => new URL(`${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`, DIR);

export async function readState(key, fallback) {
  const file = fileFor(key);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}
export const readStateStrict = readState;

export async function writeState(key, value) {
  writeFileSync(fileFor(key), JSON.stringify(value));
}

export async function readMany(keys, fallback = null) {
  return Promise.all(keys.map((key) => readState(key, fallback)));
}
