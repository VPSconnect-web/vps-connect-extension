import { PROXY_CONFIG } from '../background/proxy-config.js';

const ACTIVE_ENDPOINT_KEY = 'activeEndpointId';
const LAST_PRIMARY_RETRY_KEY = 'lastPrimaryRetryAt';
const PRIMARY_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const FALLBACK_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function getEndpoints() {
  const configured = PROXY_CONFIG.endpoints && PROXY_CONFIG.endpoints.length > 0
    ? PROXY_CONFIG.endpoints
    : [PROXY_CONFIG];

  return configured.map((endpoint, index) => ({
    id: endpoint.id || (index === 0 ? 'primary' : `endpoint-${index}`),
    label: endpoint.label || (index === 0 ? 'Основной' : `Endpoint ${index + 1}`),
    host: endpoint.host,
    port: endpoint.port,
    scheme: normalizeProxyScheme(endpoint.scheme || PROXY_CONFIG.scheme || 'http'),
    authAPI: endpoint.authAPI || PROXY_CONFIG.authAPI
  }));
}

export function getPrimaryEndpoint() {
  return getEndpoints()[0];
}

export function getProxyChain() {
  return getEndpoints()
    .map(endpoint => `${pacProxyToken(endpoint.scheme)} ${endpoint.host}:${endpoint.port}`)
    .join('; ');
}

export async function getActiveOrderedEndpoints() {
  const endpoints = getEndpoints();
  if (endpoints.length <= 1) {
    return endpoints;
  }
  const stored = await chrome.storage.local.get(ACTIVE_ENDPOINT_KEY);
  const activeId = stored[ACTIVE_ENDPOINT_KEY];
  const active = endpoints.find(endpoint => endpoint.id === activeId);
  if (!active || active.id === endpoints[0].id) {
    return endpoints;
  }
  return [active, ...endpoints.filter(endpoint => endpoint.id !== active.id)];
}

export async function getActiveOrderedProxyChain() {
  const ordered = await getActiveOrderedEndpoints();
  return ordered
    .map(endpoint => `${pacProxyToken(endpoint.scheme)} ${endpoint.host}:${endpoint.port}`)
    .join('; ');
}

export function isConfiguredAuthUrl(url) {
  let parsed;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  return getEndpoints().some(endpoint => {
    try {
      const authUrl = new URL(endpoint.authAPI.baseURL);
      return parsed.hostname === authUrl.hostname && parsed.port === authUrl.port;
    } catch {
      return false;
    }
  });
}

export async function getActiveEndpoint() {
  const endpoints = getEndpoints();
  const stored = await chrome.storage.local.get([ACTIVE_ENDPOINT_KEY, LAST_PRIMARY_RETRY_KEY]);
  return endpoints.find(endpoint => endpoint.id === stored[ACTIVE_ENDPOINT_KEY]) || endpoints[0];
}

export async function setActiveEndpoint(endpoint) {
  await chrome.storage.local.set({ [ACTIVE_ENDPOINT_KEY]: endpoint.id });
}

export async function markProxyFallback() {
  const endpoints = getEndpoints();
  if (endpoints.length <= 1) return false;
  const stored = await chrome.storage.local.get(ACTIVE_ENDPOINT_KEY);
  const currentId = stored[ACTIVE_ENDPOINT_KEY] || endpoints[0].id;
  const next = endpoints.find(e => e.id !== currentId);
  if (!next) return false;
  await setActiveEndpoint(next);
  return true;
}

export async function orderedEndpoints() {
  const endpoints = getEndpoints();
  if (endpoints.length <= 1) {
    return endpoints;
  }

  const stored = await chrome.storage.local.get([ACTIVE_ENDPOINT_KEY, LAST_PRIMARY_RETRY_KEY]);
  const activeId = stored[ACTIVE_ENDPOINT_KEY];
  const primary = endpoints[0];
  const active = endpoints.find(endpoint => endpoint.id === activeId);
  const now = Date.now();
  const lastPrimaryRetryAt = Number(stored[LAST_PRIMARY_RETRY_KEY] || 0);

  if (active && active.id !== primary.id && now - lastPrimaryRetryAt < PRIMARY_RETRY_INTERVAL_MS) {
    return [active, ...endpoints.filter(endpoint => endpoint.id !== active.id)];
  }

  await chrome.storage.local.set({ [LAST_PRIMARY_RETRY_KEY]: now });
  return endpoints;
}

export function endpointUrl(endpoint, originalUrl) {
  const original = new URL(originalUrl);
  const authBase = new URL(endpoint.authAPI.baseURL);
  original.protocol = authBase.protocol;
  original.hostname = authBase.hostname;
  original.port = authBase.port;
  return original.toString();
}

export function shouldFallbackResponse(response) {
  return FALLBACK_STATUSES.has(response.status);
}

export function shouldFallbackError(error) {
  return error instanceof TypeError || error?.name === 'AbortError';
}

function pacProxyToken(scheme) {
  const normalized = normalizeProxyScheme(scheme);
  return normalized === 'https' ? 'HTTPS' : 'PROXY';
}

function normalizeProxyScheme(scheme) {
  const normalized = (scheme || 'http').toLowerCase();
  if (normalized === 'https') return 'https';
  return 'http';
}
