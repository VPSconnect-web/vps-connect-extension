const KEY = 'diagLog';
const MAX_ENTRIES = 100;

export async function recordIncident(kind, payload = {}) {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const log = Array.isArray(stored[KEY]) ? stored[KEY] : [];
    log.push({ kind, payload, at: Date.now() });
    if (log.length > MAX_ENTRIES) {
      log.splice(0, log.length - MAX_ENTRIES);
    }
    await chrome.storage.local.set({ [KEY]: log });
  } catch (e) {
    console.warn('[diag-log] failed to record incident', e);
  }
}

export async function readIncidents() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return Array.isArray(stored[KEY]) ? stored[KEY] : [];
  } catch {
    return [];
  }
}

export async function clearIncidents() {
  try {
    await chrome.storage.local.remove(KEY);
  } catch {}
}
