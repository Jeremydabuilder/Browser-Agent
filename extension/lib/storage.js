// Storage wrapper. In the extension it uses chrome.storage; tests inject an in-memory backend.
//  - "local":   durable data the user created (assignments, memories, saved tab groups, settings)
//  - "session": in-memory only, cleared when the browser closes (chat history, Google tokens)

let backend = null;

export function setStorageBackend(b) {
  backend = b;
}

function area(name) {
  if (backend) return backend[name];
  return chrome.storage[name];
}

export async function getItem(key, fallback, areaName = 'local') {
  const result = await area(areaName).get(key);
  return result[key] === undefined ? fallback : result[key];
}

export async function setItem(key, value, areaName = 'local') {
  await area(areaName).set({ [key]: value });
}

export async function removeItem(key, areaName = 'local') {
  await area(areaName).remove(key);
}

export function createMemoryArea() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (key == null) return Object.fromEntries(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
    },
  };
}

export function createMemoryBackend() {
  return { local: createMemoryArea(), session: createMemoryArea() };
}
