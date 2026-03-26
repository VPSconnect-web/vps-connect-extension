
import { PROXY_CONFIG } from './proxy-config.js';

const AUTH_API_URL = PROXY_CONFIG.authAPI.baseURL;

export async function registerUser(email, password) {
    try {
        const response = await fetch(`${AUTH_API_URL}/api/auth/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Registration failed');
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Registration error:', error);
        throw error;
    }
}

export async function verifyEmail(email, code) {
    try {
        const response = await fetch(`${AUTH_API_URL}/api/auth/verify-email`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, code })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Verification failed');
        }
        
        const data = await response.json();
        
        await chrome.storage.local.set({ 
            jwtToken: data.token,
            user: data.user,
            isAuthenticated: true
        });
        
        return data;
    } catch (error) {
        console.error('Verification error:', error);
        throw error;
    }
}

export async function loginUser(email, password) {
    try {
        const response = await fetch(`${AUTH_API_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Login failed');
        }
        
        const data = await response.json();
        
        await chrome.storage.local.set({ 
            jwtToken: data.token,
            user: data.user,
            isAuthenticated: true
        });
        
        return data;
    } catch (error) {
        console.error('Login error:', error);
        throw error;
    }
}

export async function verifyToken(token) {
    try {
        if (!token || token.trim() === '') {
            console.warn('[Auth API] Токен пустой или отсутствует');
            return false;
        }
        
        
        const response = await fetch(`${AUTH_API_URL}/api/auth/verify`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.warn('[Auth API] Токен невалиден или истек');
            return false;
        }
        
        const data = await response.json();
        
        await chrome.storage.local.set({ 
            user: data,
            isAuthenticated: true
        });
        
        return true;
    } catch (error) {
        console.error('[Auth API] Ошибка проверки токена:', error);
        return false;
    }
}

export async function getCurrentUser(token) {
    try {
        const response = await fetch(`${AUTH_API_URL}/api/auth/me`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to get user info');
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Get user error:', error);
        throw error;
    }
}

export async function logoutUser() {
    try {
        await chrome.storage.local.remove(['jwtToken', 'user', 'isAuthenticated']);
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

export async function isAuthenticated() {
    try {
        const token = await getJWTToken();
        if (!token) {
            return false;
        }
        
        return await verifyToken(token);
    } catch (error) {
        console.error('Is authenticated error:', error);
        return false;
    }
}
