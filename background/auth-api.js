import { PROXY_CONFIG } from './proxy-config.js';
import { isAuthError, isUnreachableError, requestJson } from '../shared/api-client.js';
import { recordIncident } from '../shared/diag-log.js';

const AUTH_API_URL = PROXY_CONFIG.authAPI.baseURL;

const REFRESH_FAIL_STREAK_KEY = 'refreshFailStreak';
const REFRESH_FAIL_THRESHOLD = 5;

function getAccessToken(data) {
    return data?.token || data?.accessToken || data?.jwtToken || null;
}

function getRefreshToken(data) {
    return data?.refreshToken || data?.refresh_token || null;
}

async function getStreak(key) {
    const stored = await chrome.storage.local.get(key);
    const value = Number(stored[key] || 0);
    return Number.isFinite(value) ? value : 0;
}

async function bumpStreak(key) {
    const next = (await getStreak(key)) + 1;
    await chrome.storage.local.set({ [key]: next });
    return next;
}

async function clearStreak(key) {
    await chrome.storage.local.remove(key);
}

async function clearAuthSession(reason) {
    await chrome.storage.local.remove([
        'jwtToken',
        'refreshToken',
        'user',
        'isAuthenticated',
        'proxyAccess'
    ]);
    await recordIncident('auth-cleared', { reason });
}

async function saveAuthSession(data) {
    const values = {
        jwtToken: getAccessToken(data),
        user: data.user,
        isAuthenticated: true,
        proxyAccess: false
    };
    const refreshToken = getRefreshToken(data);
    if (refreshToken) {
        values.refreshToken = refreshToken;
    }

    await chrome.storage.local.set(values);
    await clearStreak(REFRESH_FAIL_STREAK_KEY);
}

export async function refreshAccessToken() {
    const { refreshToken } = await chrome.storage.local.get('refreshToken');
    if (!refreshToken) {
        return null;
    }

    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ refreshToken })
        }, 'Token refresh failed');

        const token = getAccessToken(data);
        if (!token) {
            throw new Error('Token refresh response did not include an access token');
        }

        const values = { jwtToken: token, isAuthenticated: true };
        const nextRefreshToken = getRefreshToken(data);
        if (nextRefreshToken) {
            values.refreshToken = nextRefreshToken;
        }
        if (data.user) {
            values.user = data.user;
        }

        await chrome.storage.local.set(values);
        await clearStreak(REFRESH_FAIL_STREAK_KEY);
        return token;
    } catch (error) {
        console.error('[Auth API] Ошибка обновления токена:', error);
        if (isAuthError(error)) {
            const next = await bumpStreak(REFRESH_FAIL_STREAK_KEY);
            await recordIncident('refresh-rejected', { status: error.status, streak: next });
            if (next >= REFRESH_FAIL_THRESHOLD) {
                await clearAuthSession('refresh-token-rejected-streak');
                await clearStreak(REFRESH_FAIL_STREAK_KEY);
            }
        } else {
            await recordIncident('refresh-unreachable', {
                status: error?.status ?? null,
                name: error?.name ?? null
            });
        }
        return null;
    }
}

export async function registerUser(email, password) {
    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/auth/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        }, 'Registration failed');
        return data;
    } catch (error) {
        console.error('Registration error:', error);
        throw error;
    }
}

export async function verifyEmail(email, code) {
    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/auth/verify-email`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, code })
        }, 'Verification failed');

        await saveAuthSession(data);

        return data;
    } catch (error) {
        console.error('Verification error:', error);
        throw error;
    }
}

export async function loginUser(email, password) {
    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        }, 'Login failed');

        await saveAuthSession(data);

        return data;
    } catch (error) {
        console.error('Login error:', error);
        throw error;
    }
}

/**
 * Tri-state token verification.
 * Returns: 'valid' | 'invalid' | 'unreachable'
 *   - valid: server подтвердил токен
 *   - invalid: сервер ответил 401/403 и refresh не помог (токен реально просрочен)
 *   - unreachable: сеть/таймаут/5xx — состояние неизвестно, не трогаем кеш
 */
export async function verifyTokenStatus(token, { allowRefresh = true } = {}) {
    if (!token || token.trim() === '') {
        return 'invalid';
    }

    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/auth/verify`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }, 'Token verification failed');

        await chrome.storage.local.set({
            user: data,
            isAuthenticated: true
        });

        return 'valid';
    } catch (error) {
        if (isAuthError(error)) {
            if (allowRefresh) {
                const refreshedToken = await refreshAccessToken();
                if (refreshedToken) {
                    return verifyTokenStatus(refreshedToken, { allowRefresh: false });
                }
            }
            return 'invalid';
        }
        if (isUnreachableError(error)) {
            console.warn('[Auth API] verifyToken unreachable:', error?.status ?? error?.name ?? error?.message);
            return 'unreachable';
        }
        console.error('[Auth API] Ошибка проверки токена:', error);
        return 'unreachable';
    }
}

/**
 * Backward-compatible boolean wrapper. Treats 'unreachable' as success
 * (assume token is still good when we can't reach the server).
 */
export async function verifyToken(token, options) {
    const result = await verifyTokenStatus(token, options);
    return result === 'valid' || result === 'unreachable';
}

/**
 * Tri-state subscription check.
 * Returns: 'active' | 'inactive' | 'unauthorized' | 'unreachable'
 */
export async function checkActiveSubscription(token, { allowRefresh = true } = {}) {
    if (!token || token.trim() === '') {
        await chrome.storage.local.set({ proxyAccess: false });
        return 'unauthorized';
    }

    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/billing/subscription`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }, 'Subscription verification failed');

        const isActive = Boolean(data?.has_active && data?.subscription);
        await chrome.storage.local.set({ proxyAccess: isActive });
        return isActive ? 'active' : 'inactive';
    } catch (error) {
        if (isAuthError(error)) {
            if (allowRefresh) {
                const refreshedToken = await refreshAccessToken();
                if (refreshedToken) {
                    return checkActiveSubscription(refreshedToken, { allowRefresh: false });
                }
            }
            return 'unauthorized';
        }
        if (isUnreachableError(error)) {
            console.warn('[Auth API] subscription check unreachable:', error?.status ?? error?.name ?? error?.message);
            return 'unreachable';
        }
        console.error('[Auth API] Ошибка проверки подписки:', error);
        return 'unreachable';
    }
}

/**
 * Backward-compatible boolean wrapper. Returns true ONLY when subscription
 * is confirmed active. Callers that need to distinguish "inactive" from
 * "unreachable" should use checkActiveSubscription().
 */
export async function hasActiveSubscription(token, options) {
    return (await checkActiveSubscription(token, options)) === 'active';
}

export async function getCurrentUser(token) {
    try {
        const { data } = await requestJson(`${AUTH_API_URL}/api/auth/me`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }, 'Failed to get user info');
        return data;
    } catch (error) {
        console.error('Get user error:', error);
        throw error;
    }
}

export async function logoutUser() {
    try {
        const token = await getJWTToken();
        if (token) {
            try {
                await requestJson(`${AUTH_API_URL}/api/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }, 'Logout failed');
            } catch (error) {
                console.warn('Backend logout failed, clearing local auth state anyway:', error);
            }
        }

        await clearAuthSession('user-logout');
    } catch (error) {
        console.error('Logout error:', error);
        throw error;
    }
}

export async function getJWTToken() {
    try {
        const result = await chrome.storage.local.get(['jwtToken']);
        return result.jwtToken || null;
    } catch (error) {
        console.error('Get JWT token error:', error);
        return null;
    }
}

/**
 * Tri-state authentication probe.
 * Returns: 'authenticated' | 'unauthenticated' | 'unreachable'
 */
export async function getAuthState() {
    try {
        const token = await getJWTToken();
        if (!token) {
            return 'unauthenticated';
        }
        const status = await verifyTokenStatus(token);
        if (status === 'valid') return 'authenticated';
        if (status === 'unreachable') return 'unreachable';
        return 'unauthenticated';
    } catch (error) {
        console.error('getAuthState error:', error);
        return 'unreachable';
    }
}

export async function isAuthenticated() {
    const state = await getAuthState();
    return state === 'authenticated' || state === 'unreachable';
}
