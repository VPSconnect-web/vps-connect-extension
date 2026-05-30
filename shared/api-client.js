import {
  endpointUrl,
  getPrimaryEndpoint,
  isConfiguredAuthUrl,
  shouldFallbackError,
  shouldFallbackResponse
} from './endpoint-manager.js';

const DEFAULT_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (options.signal) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function parseJsonResponse(response, fallbackMessage = 'Request failed') {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (!isJson) {
    let text = '';
    try {
      text = await response.text();
    } catch {}
    const message = text ? `Server returned ${response.status}: ${text.substring(0, 100)}` : fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.responseText = text;
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    const error = new Error(fallbackMessage);
    error.status = response.status;
    error.cause = parseError;
    throw error;
  }

  if (!response.ok) {
    const message = data?.error || fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export async function failoverFetch(url, options = {}) {
  // Failover temporarily disabled: all auth/API requests must go through the
  // primary endpoint only.
  return primaryOnlyFetch(url, options);
}

export async function primaryOnlyFetch(url, options = {}) {
  const { timeoutMs, retryAttempts = 1, ...fetchOptions } = options;
  const effectiveTimeout = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, Number(retryAttempts) || 1);

  if (!isConfiguredAuthUrl(url)) {
    return fetchWithTimeout(url, fetchOptions, effectiveTimeout);
  }

  const primaryUrl = endpointUrl(getPrimaryEndpoint(), url);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(primaryUrl, fetchOptions, effectiveTimeout);
      if (shouldFallbackResponse(response) && attempt < attempts) {
        lastError = new Error(`Server returned ${response.status}`);
        lastError.status = response.status;
        continue;
      }

      return response;
    } catch (error) {
      if (!shouldFallbackError(error) || attempt === attempts) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError || new Error('Primary endpoint failed');
}

export async function requestJson(url, options = {}, fallbackMessage = 'Request failed') {
  const response = await failoverFetch(url, options);
  const data = await parseJsonResponse(response, fallbackMessage);
  return { response, data };
}

export async function requestPrimaryJson(url, options = {}, fallbackMessage = 'Request failed') {
  const response = await primaryOnlyFetch(url, options);
  const data = await parseJsonResponse(response, fallbackMessage);
  return { response, data };
}

export function isUnreachableError(error) {
  if (error == null) return true;
  if (error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  if (error.status == null) return true;
  if (error.status >= 500) return true;
  if (error.status === 408 || error.status === 429) return true;
  return false;
}

export function isAuthError(error) {
  return error?.status === 401 || error?.status === 403;
}
