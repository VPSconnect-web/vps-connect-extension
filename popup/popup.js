
import { PROXY_CONFIG } from '../background/proxy-config.js';
import { failoverFetch, parseJsonResponse, requestJson, requestPrimaryJson } from '../shared/api-client.js';

// API Configuration
const API_BASE_URL = `${PROXY_CONFIG.authAPI.baseURL}/api`;
const PUBLIC_FEATURES_URL = `${API_BASE_URL}/public/features`;
const APP_UPDATE_URL = `${API_BASE_URL}/mobile/v1/app/update?version_code=0`;
const FALLBACK_APK_DOWNLOAD_URL = new URL('/android_apk.apk', PROXY_CONFIG.authAPI.baseURL).toString();
const REFRESH_FAIL_STREAK_KEY = 'refreshFailStreak';
const REFRESH_FAIL_THRESHOLD = 5;
const RESET_SESSIONS_PRIMARY_RETRY_ATTEMPTS = 5;
const PHONE_PLATFORM_ICONS = {
    android: '../icons/android-platform.png',
    iphone: '../icons/iphone-platform.png'
};

// DOM Elements
const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const apkView = document.getElementById('apk-view');
const loading = document.getElementById('loading');
const phoneDownloadBtn = document.getElementById('phone-download-btn');
const phonePlatformSwitcher = document.getElementById('phone-platform-switcher');
const phonePlatformBtns = document.querySelectorAll('.phone-platform-btn');
const phonePlatformTitle = document.getElementById('phone-platform-title');
const phonePlatformDescription = document.getElementById('phone-platform-description');
const apkQrCard = document.getElementById('apk-qr-card');
const apkQrImage = document.getElementById('apk-qr-image');
const apkDownloadUrl = document.getElementById('apk-download-url');
const apkDownloadBtn = document.getElementById('apk-download-btn');
const apkBackBtn = document.getElementById('apk-back-btn');
const phoneDownloadPlaceholder = document.getElementById('phone-download-placeholder');
const phoneDownloadPlaceholderIcon = document.getElementById('phone-download-placeholder-icon');
const phoneDownloadPlaceholderTitle = document.getElementById('phone-download-placeholder-title');
const phoneDownloadPlaceholderText = document.getElementById('phone-download-placeholder-text');

// Tab switching
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

// Forms
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const verifyForm = document.getElementById('verifyForm');
const resetSessionsBtn = document.getElementById('reset-sessions-btn');
const backToRegisterBtn = document.getElementById('back-to-register');
const forgotPasswordLink = document.getElementById('forgot-password-link');
const passwordToggleBtns = document.querySelectorAll('[data-password-toggle]');

// Forgot password modal
const forgotPasswordModal = document.getElementById('forgot-password-modal');
const forgotPasswordForm = document.getElementById('forgotPasswordForm');
const forgotPasswordEmailInput = document.getElementById('forgot-password-email');
const forgotPasswordCancelBtn = document.getElementById('forgot-password-cancel');

// Force change password view
const forceChangeView = document.getElementById('force-change-view');
const forceChangePasswordForm = document.getElementById('forceChangePasswordForm');

// Dashboard elements
const toggleProxyBtn = document.getElementById('toggle-proxy');
const proxyStatusEl = document.getElementById('proxy-status');
const logoutBtn = document.getElementById('logout-btn');

// Proxy mode elements
const modeAll = document.getElementById('mode-all');
const modeWhitelist = document.getElementById('mode-whitelist');
const whitelistSection = document.getElementById('url-whitelist-section');
const addUrlForm = document.getElementById('add-url-form');
const urlInput = document.getElementById('url-input');
const saveUrlBtn = document.getElementById('save-url-btn');
const urlList = document.getElementById('url-list');

// Error messages
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const verifyError = document.getElementById('verify-error');
const forceChangeError = document.getElementById('force-change-error');
const forgotPasswordError = document.getElementById('forgot-password-error');

// Notification banner elements
const notificationBanner = document.getElementById('notification-banner');
const notificationText = document.getElementById('notification-text');

// Subscription elements
const subscriptionSection = document.getElementById('subscription-section');
const subscriptionActive = document.getElementById('subscription-active');
const subscriptionInactive = document.getElementById('subscription-inactive');
const subscriptionEndDate = document.getElementById('subscription-end-date');
const subscriptionDaysLeft = document.getElementById('subscription-days-left');
const buySubscriptionBtn = document.getElementById('buy-subscription-btn');
const extendSubscriptionBtn = document.getElementById('extend-subscription-btn');
const planOptions = document.querySelectorAll('.plan-option');
const extendSubscriptionModal = document.getElementById('extend-subscription-modal');
const extendPlanOptions = document.querySelectorAll('.extend-plan-option');
const extendModalCancel = document.getElementById('extend-modal-cancel');
const extendModalConfirm = document.getElementById('extend-modal-confirm');

// Store email for verification
let pendingVerificationEmail = null;
let selectedPeriod = 3; // Default: 3 months
let extendSelectedPeriod = 3; // Default for extend modal
let transientBannerTimer = null;
let previousViewBeforeApk = 'auth-view';
let showPhoneDownloadButton = true;
let hasPhoneDownloadButtonFlag = false;
let apkDownloadUrlValue = FALLBACK_APK_DOWNLOAD_URL;
let selectedPhonePlatform = 'android';
let phoneDownloadConfig = createDefaultPhoneDownloadConfig();

const AUTH_STATE_KEY = 'auth_flow_state';
const TTL_MS = 5 * 60 * 1000;

// Password reset flow
const PENDING_RESET_EMAIL_KEY = 'pendingPasswordResetEmail';
const PENDING_RESET_TEMP_PASSWORD_KEY = 'pendingTempPassword';

/**
 * Forgot password modal controls
 */
function openForgotPasswordModal() {
    if (!forgotPasswordModal) return;

    // Pre-fill email from login form if available
    const loginEmailInput = document.getElementById('login-email');
    if (loginEmailInput && forgotPasswordEmailInput) {
        forgotPasswordEmailInput.value = loginEmailInput.value.trim();
    }

    if (forgotPasswordError) {
        hideError(forgotPasswordError);
    }

    forgotPasswordModal.classList.remove('hidden');
    if (forgotPasswordEmailInput) {
        forgotPasswordEmailInput.focus();
    }
}

function closeForgotPasswordModal() {
    if (!forgotPasswordModal) return;
    forgotPasswordModal.classList.add('hidden');
}

function runBackgroundTask(task, label) {
    Promise.resolve()
        .then(task)
        .catch(error => {
            console.warn(`[Popup] Background task failed: ${label}`, error);
        });
}

function initializePasswordToggles() {
    passwordToggleBtns.forEach((button) => {
        const inputId = button.dataset.passwordToggle;
        const input = document.getElementById(inputId);
        if (!input) return;

        button.addEventListener('click', () => {
            const shouldShow = input.type === 'password';
            input.type = shouldShow ? 'text' : 'password';
            button.classList.toggle('is-visible', shouldShow);
            button.setAttribute('aria-pressed', String(shouldShow));
            button.setAttribute('aria-label', shouldShow ? 'Скрыть пароль' : 'Показать пароль');
            input.focus();
        });
    });
}

function hideNotificationBanner() {
    if (!notificationBanner) return;
    notificationBanner.classList.add('hidden');
    notificationBanner.removeAttribute('data-temporary');
}

function showNotificationBanner(notification, options = {}) {
    if (!notification || !notificationBanner || !notificationText) return;

    const timeoutMs = options.timeoutMs ?? 0;

    if (transientBannerTimer) {
        clearTimeout(transientBannerTimer);
        transientBannerTimer = null;
    }

    notificationBanner.className = 'notification-banner';
    notificationBanner.classList.add(notification.type || 'info');
    notificationText.textContent = notification.message;
    notificationBanner.classList.remove('hidden');

    if (timeoutMs > 0) {
        notificationBanner.dataset.temporary = 'true';
        transientBannerTimer = setTimeout(() => {
            hideNotificationBanner();
        }, timeoutMs);
    }
}

function showTransientMessage(message, type = 'info', timeoutMs = 3500) {
    showNotificationBanner({ message, type }, { timeoutMs });
}

function setButtonBusy(button, isBusy, busyLabel = null) {
    if (!button) return;

    if (isBusy) {
        if (!button.dataset.originalText) {
            const labelNode = button.querySelector('span');
            button.dataset.originalText = labelNode ? labelNode.textContent : button.textContent.trim();
        }

        button.disabled = true;
        button.setAttribute('aria-busy', 'true');

        if (busyLabel) {
            const labelNode = button.querySelector('span');
            if (labelNode) {
                labelNode.textContent = busyLabel;
            } else {
                button.textContent = busyLabel;
            }
        }
        return;
    }

    button.disabled = false;
    button.removeAttribute('aria-busy');

    if (button.dataset.originalText) {
        const labelNode = button.querySelector('span');
        if (labelNode) {
            labelNode.textContent = button.dataset.originalText;
        } else {
            button.textContent = button.dataset.originalText;
        }
    }
}

/**
 * Handle forgot password submit
 */
async function handleForgotPassword(e) {
    if (e) {
        e.preventDefault();
    }

    if (!forgotPasswordEmailInput) return;

    const email = forgotPasswordEmailInput.value.trim();

    if (!email) {
        showError(forgotPasswordError, 'Введите email, чтобы сбросить пароль');
        return;
    }

    hideError(forgotPasswordError);
    showLoading();

    try {
        const response = await failoverFetch(`${API_BASE_URL}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        if (response.ok) {
            await savePendingPasswordResetEmail(email);
            showTransientMessage('Если такой email зарегистрирован, временный пароль уже отправлен.', 'success');
            closeForgotPasswordModal();
        } else {
            console.error('[Popup] Forgot password error status:', response.status);
            showError(forgotPasswordError, 'Не удалось отправить письмо, попробуйте позже');
        }
    } catch (error) {
        console.error('[Popup] Forgot password error:', error);
        showError(forgotPasswordError, 'Не удалось отправить письмо, попробуйте позже');
    } finally {
        hideLoading();
    }
}

/**
 * Handle force change password after login with temporary password
 */
async function handleForceChangePassword(e) {
    e.preventDefault();

    const newPassword = document.getElementById('new-password').value;
    const newPasswordConfirm = document.getElementById('new-password-confirm').value;

    hideError(forceChangeError);

    if (newPassword !== newPasswordConfirm) {
        showError(forceChangeError, 'Пароли не совпадают');
        return;
    }

    if (newPassword.length < 8) {
        showError(forceChangeError, 'Пароль должен содержать минимум 8 символов');
        return;
    }

    showLoading();

    try {
        const token = await getToken();
        const pending = await getPendingPasswordReset();

        if (!token) {
            showError(forceChangeError, 'Токен не найден. Пожалуйста, войдите снова.');
            hideLoading();
            return;
        }

        if (!pending.tempPassword) {
            showError(forceChangeError, 'Временный пароль не найден. Пожалуйста, войдите снова.');
            hideLoading();
            return;
        }

        const response = await authenticatedFetch(`${API_BASE_URL}/auth/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                old_password: pending.tempPassword,
                new_password: newPassword
            })
        });

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('[Popup] Не JSON ответ:', text);
            throw new Error(`Сервер вернул ${response.status}: ${text.substring(0, 100)}`);
        }

        const data = await response.json();

        if (response.ok) {
            await clearPendingPasswordReset();
            showTransientMessage('Пароль успешно изменён.', 'success');
            forceChangePasswordForm.reset();
            await showDashboard();
        } else {
            if (data.error && data.error.includes('invalid old password')) {
                showError(forceChangeError, 'Неверный временный пароль');
            } else if (data.error && data.error.includes('password validation failed')) {
                showError(forceChangeError, 'Пароль не соответствует требованиям');
            } else {
                showError(forceChangeError, data.error || 'Ошибка смены пароля');
            }
        }
    } catch (error) {
        console.error('[Popup] Force change password error:', error);
        showError(forceChangeError, 'Не удалось подключиться к серверу');
    } finally {
        hideLoading();
    }
}

async function loadAuthState() {
    const res = await chrome.storage.session.get(AUTH_STATE_KEY);
    const state = res[AUTH_STATE_KEY];
    if (!state) return null;
    if (state.expiresAt && Date.now() > state.expiresAt) {
        await chrome.storage.session.remove(AUTH_STATE_KEY);
        return null;
    }
    return state;
}

async function saveAuthState(partial) {
    const res = await chrome.storage.session.get(AUTH_STATE_KEY);
    const prev = res[AUTH_STATE_KEY] || {};
    const state = { ...prev, ...partial, expiresAt: Date.now() + TTL_MS };
    await chrome.storage.session.set({ [AUTH_STATE_KEY]: state });
    try { await chrome.runtime.sendMessage({ action: 'authState:scheduleExpire', when: state.expiresAt }); } catch (e) {}
}

async function clearAuthState() {
    await chrome.storage.session.remove(AUTH_STATE_KEY);
    try { await chrome.runtime.sendMessage({ action: 'authState:clear' }); } catch (e) {}
}

async function tryRestoreAuthState() {
    const token = await getToken();
    if (token) return;
    const state = await loadAuthState();
    if (state && state.step === 'verify' && state.email) {
        pendingVerificationEmail = state.email;
        document.getElementById('verify-email-display').textContent = state.email;
        switchTab('verify');
    }
}

// Password reset helpers
async function getPendingPasswordReset() {
    const res = await chrome.storage.local.get([PENDING_RESET_EMAIL_KEY, PENDING_RESET_TEMP_PASSWORD_KEY]);
    return {
        email: res[PENDING_RESET_EMAIL_KEY] || null,
        tempPassword: res[PENDING_RESET_TEMP_PASSWORD_KEY] || null
    };
}

async function savePendingPasswordResetEmail(email) {
    await chrome.storage.local.set({ [PENDING_RESET_EMAIL_KEY]: email });
}

async function savePendingTempPassword(password) {
    await chrome.storage.local.set({ [PENDING_RESET_TEMP_PASSWORD_KEY]: password });
}

async function clearPendingPasswordReset() {
    await chrome.storage.local.remove([PENDING_RESET_EMAIL_KEY, PENDING_RESET_TEMP_PASSWORD_KEY]);
}

/**
 * Notification Banner Functions
 */

// URL страницы уведомлений на сайте
const NOTIFICATIONS_URL = 'https://www.vpsconect.ru/notifications.html';

// Fetch and parse notifications from HTML page
async function fetchNotifications() {
    try {
        const response = await fetch(NOTIFICATIONS_URL, {
            method: 'GET',
            cache: 'no-cache'
        });
        
        if (!response.ok) {
            return null;
        }
        
        const html = await response.text();
        
        // Parse HTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Find notification element
        const notificationEl = doc.getElementById('notification');
        
        if (!notificationEl) {
            return null;
        }
        
        // Extract data
        const notification = {
            id: notificationEl.dataset.id || 'default',
            type: notificationEl.dataset.type || 'info',
            message: notificationEl.textContent.trim()
        };
        
        // Skip empty messages
        if (!notification.message) {
            return null;
        }
        
        return { notification };
    } catch (error) {
        console.warn('[Popup] Failed to fetch notifications:', error);
        return null;
    }
}

// Load and display notifications
async function loadNotifications() {
    const data = await fetchNotifications();
    
    if (data && data.notification) {
        showNotificationBanner(data.notification);
    }
}

async function fetchPublicFeatureFlags() {
    try {
        const response = await failoverFetch(PUBLIC_FEATURES_URL, {
            method: 'GET',
            cache: 'no-cache'
        });

        if (!response.ok) {
            console.warn('[Popup] Failed to fetch public feature flags:', response.status);
            return {};
        }

        return await response.json();
    } catch (error) {
        console.warn('[Popup] Failed to fetch public feature flags:', error);
        return {};
    }
}

async function loadPublicFeatureFlags() {
    const flags = await fetchPublicFeatureFlags();
    hasPhoneDownloadButtonFlag = Object.prototype.hasOwnProperty.call(flags, 'phone_download_button_enabled')
        || Object.prototype.hasOwnProperty.call(flags, 'show_phone_download_button');

    if (hasPhoneDownloadButtonFlag) {
        showPhoneDownloadButton = readBoolean(
            flags.phone_download_button_enabled ?? flags.show_phone_download_button,
            false
        );
    }

    applyPhoneDownloadFeatureFlag();
}

function applyPhoneDownloadFeatureFlag() {
    if (!phoneDownloadBtn) return;

    phoneDownloadBtn.classList.toggle('hidden', !showPhoneDownloadButton);
    phoneDownloadBtn.setAttribute('aria-hidden', showPhoneDownloadButton ? 'false' : 'true');

    if (!showPhoneDownloadButton && apkView && !apkView.classList.contains('hidden')) {
        restorePreviousViewFromApk();
    }
}

function buildApkQrCodeUrl(downloadUrl) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(downloadUrl)}`;
}

function resolveApkDownloadUrl(downloadUrl) {
    const normalized = String(downloadUrl || '').trim();
    if (!normalized) {
        return '';
    }

    try {
        return new URL(normalized, PROXY_CONFIG.authAPI.baseURL).toString();
    } catch (error) {
        console.warn('[Popup] Invalid APK download URL:', normalized, error);
        return '';
    }
}

async function fetchAppUpdateMetadata() {
    try {
        const response = await failoverFetch(APP_UPDATE_URL, {
            method: 'GET',
            cache: 'no-cache'
        });

        if (!response.ok) {
            console.warn('[Popup] Failed to fetch app update metadata:', response.status);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.warn('[Popup] Failed to fetch app update metadata:', error);
        return null;
    }
}

async function loadApkDownloadMetadata() {
    const metadata = await fetchAppUpdateMetadata();
    const resolvedDownloadUrl = resolveApkDownloadUrl(metadata?.apk_url);
    if (!resolvedDownloadUrl) {
        return;
    }

    apkDownloadUrlValue = resolvedDownloadUrl;
    phoneDownloadConfig = createDefaultPhoneDownloadConfig();
    setupApkDownloadView();
}

function createDefaultPhoneDownloadConfig() {
    return {
        buttonLabel: 'Версии Для Телефона',
        defaultPlatform: 'android',
        platforms: {
            android: {
                title: 'VPS Connect на Android',
                description: 'Отсканируйте QR-код камерой телефона и установите Android APK.',
                downloadUrl: apkDownloadUrlValue,
                buttonLabel: 'Скачать APK',
                showQr: true,
                placeholderTitle: '',
                placeholderText: ''
            },
            iphone: {
                title: 'VPS Connect на iPhone',
                description: 'Версия для iPhone готовится. APK подходит только для Android.',
                downloadUrl: '',
                buttonLabel: 'Для iPhone скоро',
                showQr: false,
                placeholderTitle: 'Версия для iPhone готовится',
                placeholderText: 'APK подходит только для Android.'
            }
        }
    };
}

function readBoolean(value, fallback = null) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return fallback;
}

/**
 * Initialize popup
 */
async function init() {
    setupApkDownloadView();
    applyPhoneDownloadFeatureFlag();
    setupEventListeners();

    runBackgroundTask(loadApkDownloadMetadata, 'app update metadata');
    runBackgroundTask(loadPublicFeatureFlags, 'public feature flags');
    runBackgroundTask(loadNotifications, 'notifications');
    
    // Check if user is authenticated
    const token = await getToken();
    
    if (token) {
        const verification = await verifyToken(token);
        if (verification.status === 'valid') {
            await showDashboard();
        } else if (verification.status === 'unreachable') {
            showDashboard();
            showTransientMessage('Сервер временно недоступен. Локальная сессия сохранена.', 'info', 4500);
        } else {
            await clearToken();
            showAuth();
        }
    } else {
        showAuth();
    }
    
    await tryRestoreAuthState();
    
}

async function syncWhitelistFromServer() {
    try {
        const serverUrls = await fetchServerWhitelist();
        if (serverUrls && Array.isArray(serverUrls)) {
            const normalizedUrls = normalizeWhitelist(serverUrls);
            await chrome.storage.local.set({ urlWhitelist: normalizedUrls });
            try {
                await chrome.runtime.sendMessage({ action: 'updateWhitelist', urls: normalizedUrls });
            } catch (err) {
                console.error('[Popup] Error sending updateWhitelist after server sync:', err);
            }
        }
    } catch (e) {
        console.warn('[Popup] Failed to sync whitelist from server, using local cache', e);
    }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    initializePasswordToggles();

    if (phoneDownloadBtn) {
        phoneDownloadBtn.addEventListener('click', handlePhoneDownloadClick);
    }

    if (apkDownloadBtn) {
        apkDownloadBtn.addEventListener('click', openApkDownloadUrl);
    }

    if (apkBackBtn) {
        apkBackBtn.addEventListener('click', restorePreviousViewFromApk);
    }

    if (apkDownloadUrl) {
        apkDownloadUrl.addEventListener('click', (event) => {
            event.preventDefault();
            openApkDownloadUrl();
        });
    }

    phonePlatformBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setPhonePlatform(btn.dataset.phonePlatform);
        });
    });

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            switchTab(tabName);
        });
    });
    
    // Login form
    loginForm.addEventListener('submit', handleLogin);
    if (resetSessionsBtn) {
        resetSessionsBtn.addEventListener('click', handleResetSessionsAndLogin);
    }
    
    // Register form
    registerForm.addEventListener('submit', handleRegister);
    
    // Verify form
    verifyForm.addEventListener('submit', handleVerifyEmail);
    backToRegisterBtn.addEventListener('click', async () => { await clearAuthState(); switchTab('register'); });

    // Forgot password
    if (forgotPasswordLink) {
        forgotPasswordLink.addEventListener('click', openForgotPasswordModal);
    }

    if (forgotPasswordCancelBtn) {
        forgotPasswordCancelBtn.addEventListener('click', closeForgotPasswordModal);
    }

    if (forgotPasswordForm) {
        forgotPasswordForm.addEventListener('submit', handleForgotPassword);
    }
    
    // Toggle proxy
    toggleProxyBtn.addEventListener('click', handleToggleProxy);
    
    // Logout
    logoutBtn.addEventListener('click', handleLogout);
    
    // Proxy mode selection
    modeAll.addEventListener('change', handleModeChange);
    modeWhitelist.addEventListener('change', handleModeChange);
    
    // URL whitelist management
    saveUrlBtn.addEventListener('click', handleAddUrl);
    urlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleAddUrl();
        }
    });
    
    // Subscription management
    buySubscriptionBtn.addEventListener('click', handleBuySubscription);
    extendSubscriptionBtn.addEventListener('click', openExtendModal);
    
    // Plan selection
    planOptions.forEach(option => {
        option.addEventListener('click', () => {
            selectedPeriod = parseInt(option.dataset.period);
            applySelectedPeriodVisual();
        });
    });
    applySelectedPeriodVisual();

    // Extend modal plan selection
    extendPlanOptions.forEach(option => {
        option.addEventListener('click', () => {
            extendSelectedPeriod = parseInt(option.dataset.period);
            applyExtendPeriodVisual();
        });
    });

    // Extend modal buttons
    extendModalCancel.addEventListener('click', closeExtendModal);
    extendModalConfirm.addEventListener('click', handleExtendConfirm);

    // Force change password form
    if (forceChangePasswordForm) {
        forceChangePasswordForm.addEventListener('submit', handleForceChangePassword);
    }
}

function applySelectedPeriodVisual() {
    planOptions.forEach(opt => {
        const period = parseInt(opt.dataset.period);
        opt.classList.toggle('selected', period === selectedPeriod);
    });
}

function applyExtendPeriodVisual() {
    extendPlanOptions.forEach(opt => {
        const period = parseInt(opt.dataset.period);
        opt.classList.toggle('selected', period === extendSelectedPeriod);
    });
}

function openExtendModal() {
    applyExtendPeriodVisual();
    extendSubscriptionModal.classList.remove('hidden');
}

function closeExtendModal() {
    extendSubscriptionModal.classList.add('hidden');
}

async function handleExtendConfirm() {
    closeExtendModal();
    const savedPeriod = selectedPeriod;
    selectedPeriod = extendSelectedPeriod;
    await handleBuySubscription();
    selectedPeriod = savedPeriod;
}

function getPhonePlatformConfig(platform = selectedPhonePlatform) {
    return phoneDownloadConfig.platforms?.[platform] || createDefaultPhoneDownloadConfig().platforms[platform];
}

function setupApkDownloadView() {
    if (phoneDownloadBtn && phoneDownloadConfig.buttonLabel) {
        phoneDownloadBtn.textContent = phoneDownloadConfig.buttonLabel;
    }

    updatePhonePlatformView();
}

function setPhonePlatform(platform) {
    selectedPhonePlatform = platform === 'iphone' ? 'iphone' : 'android';
    updatePhonePlatformView();
}

function updatePhonePlatformView() {
    const isAndroid = selectedPhonePlatform === 'android';
    const platformConfig = getPhonePlatformConfig();
    const downloadUrl = platformConfig?.downloadUrl || '';
    const showQr = platformConfig?.showQr === true && Boolean(downloadUrl);
    const showPlaceholder = !downloadUrl && !showQr;

    phonePlatformBtns.forEach(btn => {
        const isActive = btn.dataset.phonePlatform === selectedPhonePlatform;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    if (phonePlatformTitle) {
        phonePlatformTitle.textContent = platformConfig?.title || (isAndroid ? 'VPS Connect на Android' : 'VPS Connect на iPhone');
    }

    if (phonePlatformDescription) {
        phonePlatformDescription.textContent = platformConfig?.description || '';
    }

    if (apkQrCard) {
        apkQrCard.classList.toggle('hidden', !showQr);
    }

    if (apkQrImage && downloadUrl) {
        apkQrImage.src = buildApkQrCodeUrl(downloadUrl);
    }

    if (phoneDownloadPlaceholder) {
        phoneDownloadPlaceholder.classList.toggle('hidden', !showPlaceholder);
    }

    if (phoneDownloadPlaceholderIcon) {
        phoneDownloadPlaceholderIcon.src = PHONE_PLATFORM_ICONS[selectedPhonePlatform] || PHONE_PLATFORM_ICONS.android;
    }

    if (phoneDownloadPlaceholderTitle) {
        phoneDownloadPlaceholderTitle.textContent = platformConfig?.placeholderTitle || '';
    }

    if (phoneDownloadPlaceholderText) {
        phoneDownloadPlaceholderText.textContent = platformConfig?.placeholderText || '';
    }

    if (apkDownloadUrl) {
        apkDownloadUrl.href = downloadUrl || '#';
        apkDownloadUrl.textContent = '';
        apkDownloadUrl.classList.add('hidden');
        apkDownloadUrl.setAttribute('aria-hidden', 'true');
        apkDownloadUrl.setAttribute('tabindex', '-1');
    }

    if (apkDownloadBtn) {
        apkDownloadBtn.disabled = !downloadUrl;
        apkDownloadBtn.textContent = platformConfig?.buttonLabel || (downloadUrl ? 'Скачать' : 'Скоро');
    }
}

function setPhonePlatformSwitcherVisible(isVisible) {
    if (!phonePlatformSwitcher) return;

    phonePlatformSwitcher.classList.toggle('hidden', !isVisible);
}

function setPhoneDownloadButtonActive(isActive) {
    if (!phoneDownloadBtn) return;

    phoneDownloadBtn.classList.toggle('active', isActive);
    phoneDownloadBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
}

function getCurrentMainViewId() {
    const views = [authView, dashboardView, forceChangeView].filter(Boolean);
    const currentView = views.find(view => !view.classList.contains('hidden'));
    return currentView ? currentView.id : 'auth-view';
}

function hideMainViews() {
    authView.classList.add('hidden');
    dashboardView.classList.add('hidden');
    if (forceChangeView) {
        forceChangeView.classList.add('hidden');
    }
}

function handlePhoneDownloadClick() {
    if (!showPhoneDownloadButton) return;

    if (apkView && !apkView.classList.contains('hidden')) {
        restorePreviousViewFromApk();
        return;
    }

    showApkDownloadView();
}

function showApkDownloadView() {
    if (!apkView) return;

    previousViewBeforeApk = getCurrentMainViewId();
    hideMainViews();
    setPhonePlatformSwitcherVisible(true);
    apkView.classList.remove('hidden');
    setPhoneDownloadButtonActive(true);
    updatePhonePlatformView();
}

function restorePreviousViewFromApk() {
    if (apkView) {
        apkView.classList.add('hidden');
    }

    setPhonePlatformSwitcherVisible(false);
    setPhoneDownloadButtonActive(false);

    const previousView = document.getElementById(previousViewBeforeApk) || authView;
    previousView.classList.remove('hidden');
}

function openApkDownloadUrl() {
    const downloadUrl = getPhonePlatformConfig()?.downloadUrl;
    if (!downloadUrl) return;

    try {
        chrome.tabs.create({ url: downloadUrl });
    } catch (error) {
        console.warn('[Popup] Failed to open APK download URL in new tab:', error);
        window.open(downloadUrl, '_blank', 'noopener');
    }
}

/**
 * Switch tabs
 */
function switchTab(tabName) {
    tabBtns.forEach(btn => btn.classList.remove('active'));
    tabContents.forEach(content => content.classList.remove('active'));
    
    if (tabName === 'verify') {
        // Show verify form without tab button
        document.getElementById('verify-form').classList.add('active');
    } else {
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-form`).classList.add('active');
    }
    
    // Clear errors
    hideError(loginError);
    hideError(registerError);
    hideError(verifyError);
    setResetSessionsVisible(false);
}

function isSessionLimitError(error) {
    return error?.data?.code === 'SESSION_LIMIT_EXCEEDED' ||
        String(error?.message || '').includes('SESSION_LIMIT_EXCEEDED') ||
        String(error?.message || '').includes('лимит активных сессий');
}

function setResetSessionsVisible(visible) {
    if (!resetSessionsBtn) {
        return;
    }
    resetSessionsBtn.classList.toggle('hidden', !visible);
}

async function performLogin(email, password) {
    const { data } = await requestJson(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    }, 'Ошибка входа');

    await saveAuthSession(data);

    const pending = await getPendingPasswordReset();
    if (pending.email && pending.email === email) {
        await savePendingTempPassword(password);
        await showForceChangePasswordView();
    } else {
        await showDashboard();

        const proxyEnabled = await getProxyStatus();
        if (!proxyEnabled) {
            try {
                const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
                if (response.success) {
                    updateProxyStatus(response.enabled);
                }
            } catch (error) {
                console.error('[Popup] Failed to auto-enable proxy after login:', error);
            }
        }
    }
}

/**
 * Handle login
 */
async function handleLogin(e) {
    e.preventDefault();
    
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    
    hideError(loginError);
    setResetSessionsVisible(false);
    showLoading();
    
    try {
        await performLogin(email, password);
        loginForm.reset();
    } catch (error) {
        console.error('[Popup] Login error:', error);
        if (isSessionLimitError(error)) {
            setResetSessionsVisible(true);
            showError(loginError, 'Достигнут лимит устройств. Можно сбросить активные сессии со всех устройств и войти заново.');
        } else {
            showError(loginError, error.message || 'Не удалось подключиться к серверу');
        }
    } finally {
        hideLoading();
    }
}

async function handleResetSessionsAndLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    hideError(loginError);
    if (!email || !password) {
        showError(loginError, 'Введите email и пароль');
        return;
    }
    showLoading();

    try {
        await requestPrimaryJson(`${API_BASE_URL}/auth/sessions/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            retryAttempts: RESET_SESSIONS_PRIMARY_RETRY_ATTEMPTS
        }, 'Ошибка сброса сессий');
        setResetSessionsVisible(false);
        await performLogin(email, password);
        loginForm.reset();
    } catch (error) {
        console.error('[Popup] Reset sessions error:', error);
        showError(loginError, error.message || 'Не удалось сбросить активные сессии');
    } finally {
        hideLoading();
    }
}

/**
 * Handle register
 */
async function handleRegister(e) {
    e.preventDefault();
    
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;
    const passwordConfirm = document.getElementById('register-password-confirm').value;
    
    hideError(registerError);
    
    // Validate passwords match
    if (password !== passwordConfirm) {
        showError(registerError, 'Пароли не совпадают');
        return;
    }
    
    // Validate password length
    if (password.length < 8) {
        showError(registerError, 'Пароль должен содержать минимум 8 символов');
        return;
    }
    
    showLoading();
    
    try {
        const { data } = await requestJson(`${API_BASE_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        }, 'Ошибка регистрации');

        pendingVerificationEmail = email;
        document.getElementById('verify-email-display').textContent = email;
        await saveAuthState({ step: 'verify', email });
        registerForm.reset();
        switchTab('verify');
    } catch (error) {
        console.error('[Popup] Register error:', error);
        showError(registerError, error.message || 'Не удалось подключиться к серверу');
    } finally {
        hideLoading();
    }
}

/**
 * Handle email verification
 */
async function handleVerifyEmail(e) {
    e.preventDefault();
    
    const code = document.getElementById('verify-code').value;
    
    if (!pendingVerificationEmail) {
        showError(verifyError, 'Email не найден. Пожалуйста, зарегистрируйтесь снова.');
        return;
    }
    
    hideError(verifyError);
    showLoading();
    
    try {
        const response = await failoverFetch(`${API_BASE_URL}/auth/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                email: pendingVerificationEmail, 
                code: code 
            })
        });

        const data = await parseJsonResponse(response, 'Неверный код. Проверьте код из письма.');
        await saveAuthSession(data);

        pendingVerificationEmail = null;
        await clearAuthState();

        await showDashboard();
        verifyForm.reset();
    } catch (error) {
        console.error('[Popup] Verification error:', error);
        showError(verifyError, error.message || 'Не удалось подключиться к серверу');
    } finally {
        hideLoading();
    }
}

/**
 * Handle toggle proxy
 */
async function handleToggleProxy() {
    setButtonBusy(toggleProxyBtn, true, 'Подключение...');
    try {
        const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
        
        if (response.success) {
            const runtimeStatus = await getRuntimeProxyStatus();
            updateProxyStatus(response.enabled, runtimeStatus.detail);
            showTransientMessage(
                response.enabled ? 'Прокси включён.' : 'Прокси отключён.',
                response.enabled ? 'success' : 'info'
            );
        } else {
            showNotificationBanner({
                type: 'error',
                message: `Ошибка подключения: ${response.error || 'Unknown error'}`
            });
        }
    } catch (error) {
        console.error('[Popup] Toggle proxy error:', error);
        showNotificationBanner({
            type: 'error',
            message: `Ошибка: ${error.message}`
        });
    } finally {
        setButtonBusy(toggleProxyBtn, false);
    }
}

/**
 * Handle logout
 */
async function handleLogout() {
    const token = await getToken();
    if (token) {
        try {
            await requestJson(`${API_BASE_URL}/auth/logout`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }, 'Не удалось завершить серверную сессию');
        } catch (error) {
            console.warn('[Popup] Backend logout failed, clearing local session anyway:', error);
        }
    }

    try {
        await chrome.runtime.sendMessage({ action: 'disable' });
    } catch (error) {
        console.warn('[Popup] Failed to disable proxy during logout:', error);
    }

    await clearToken();
    await clearUser();
    await clearPendingPasswordReset();
    showAuth();
}

/**
 * Verify token
 */
async function verifyToken(token, { allowRefresh = true } = {}) {
    try {
        const response = await failoverFetch(`${API_BASE_URL}/auth/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            return { status: 'valid' };
        }

        if (response.status === 401 || response.status === 403) {
            if (allowRefresh) {
                const refreshedToken = await refreshAccessToken();
                if (refreshedToken) {
                    return verifyToken(refreshedToken, { allowRefresh: false });
                }
                if (await hasRefreshSession()) {
                    return { status: 'unreachable' };
                }
            }
            return { status: 'invalid' };
        }

        console.warn('[Popup] Token verification returned unexpected status:', response.status);
        return { status: 'unreachable' };
    } catch (error) {
        console.error('[Popup] Token verification error:', error);
        return { status: 'unreachable', error };
    }
}

/**
 * Show/hide views
 */
function showAuth() {
    authView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
    if (apkView) {
        apkView.classList.add('hidden');
    }
    setPhonePlatformSwitcherVisible(false);
    if (forceChangeView) {
        forceChangeView.classList.add('hidden');
    }
    setPhoneDownloadButtonActive(false);
}

async function showDashboard() {
    authView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    if (apkView) {
        apkView.classList.add('hidden');
    }
    setPhonePlatformSwitcherVisible(false);
    if (forceChangeView) {
        forceChangeView.classList.add('hidden');
    }
    setPhoneDownloadButtonActive(false);

    showSubscriptionLoading();

    const [runtimeStatus] = await Promise.all([
        getRuntimeProxyStatus(),
        loadProxyMode(),
        loadUrlWhitelist()
    ]);

    updateProxyStatus(runtimeStatus.enabled, runtimeStatus.detail);

    runBackgroundTask(async () => {
        await syncWhitelistFromServer();
        await loadUrlWhitelist();
    }, 'server whitelist sync');

    runBackgroundTask(loadSubscription, 'subscription data');
}

async function showForceChangePasswordView() {
    authView.classList.add('hidden');
    dashboardView.classList.add('hidden');
    if (apkView) {
        apkView.classList.add('hidden');
    }
    setPhonePlatformSwitcherVisible(false);
    if (forceChangeView) {
        forceChangeView.classList.remove('hidden');
    }
    setPhoneDownloadButtonActive(false);
}

/**
 * Update proxy status UI
 */
function updateProxyStatus(enabled, detailMessage = null) {
    const statusIndicator = proxyStatusEl.querySelector('.status-indicator');
    const statusText = proxyStatusEl.querySelector('span:last-child');
    const toggleIcon = toggleProxyBtn.querySelector('svg path');
    const toggleText = toggleProxyBtn.querySelector('span');
    
    if (enabled) {
        statusIndicator.classList.remove('off');
        statusIndicator.classList.add('on');
        statusText.textContent = 'Включен';
        
        toggleProxyBtn.classList.add('active');
        toggleText.textContent = 'Отключиться';
        toggleIcon.setAttribute('d', 'M8 12h8');
    } else {
        statusIndicator.classList.remove('on');
        statusIndicator.classList.add('off');
        statusText.textContent = 'Выключен';
        
        toggleProxyBtn.classList.remove('active');
        toggleText.textContent = 'Подключиться';
        toggleIcon.setAttribute('d', 'M8 12h8');
    }
}

/**
 * Error handling
 */
function showError(element, message) {
    element.textContent = message;
    element.classList.add('show');
}

function hideError(element) {
    element.classList.remove('show');
    element.textContent = '';
}

/**
 * Loading state
 */
function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

/**
 * Storage helpers
 */
async function saveToken(token) {
    return chrome.storage.local.set({ jwtToken: token, proxyAccess: false });
}

function getAccessToken(data) {
    return data?.token || data?.accessToken || data?.jwtToken || null;
}

function getRefreshToken(data) {
    return data?.refreshToken || data?.refresh_token || null;
}

async function saveAuthSession(data) {
    const token = getAccessToken(data);
    if (!token) {
        throw new Error('Сервер не вернул токен сессии');
    }

    const values = {
        jwtToken: token,
        proxyAccess: false
    };
    const refreshToken = getRefreshToken(data);
    if (refreshToken) {
        values.refreshToken = refreshToken;
    }

    await chrome.storage.local.set(values);
    await clearRefreshFailStreak();
    if (data.user) {
        await saveUser(data.user);
    }
}

async function getToken() {
    const result = await chrome.storage.local.get('jwtToken');
    return result.jwtToken;
}

async function getRefreshTokenFromStorage() {
    const result = await chrome.storage.local.get('refreshToken');
    return result.refreshToken;
}

async function hasRefreshSession() {
    const result = await chrome.storage.local.get('refreshToken');
    return Boolean(result.refreshToken);
}

async function getRefreshFailStreak() {
    const result = await chrome.storage.local.get(REFRESH_FAIL_STREAK_KEY);
    const value = Number(result[REFRESH_FAIL_STREAK_KEY] || 0);
    return Number.isFinite(value) ? value : 0;
}

async function bumpRefreshFailStreak() {
    const next = (await getRefreshFailStreak()) + 1;
    await chrome.storage.local.set({ [REFRESH_FAIL_STREAK_KEY]: next });
    return next;
}

async function clearRefreshFailStreak() {
    await chrome.storage.local.remove(REFRESH_FAIL_STREAK_KEY);
}

async function refreshAccessToken() {
    const refreshToken = await getRefreshTokenFromStorage();
    if (!refreshToken) {
        return null;
    }

    try {
        const { data } = await requestJson(`${API_BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ refreshToken })
        }, 'Не удалось обновить сессию');

        const token = getAccessToken(data);
        if (!token) {
            throw new Error('Сервер не вернул токен сессии');
        }

        const values = { jwtToken: token };
        const nextRefreshToken = getRefreshToken(data);
        if (nextRefreshToken) {
            values.refreshToken = nextRefreshToken;
        }
        await chrome.storage.local.set(values);
        if (data.user) {
            await saveUser(data.user);
        }
        await clearRefreshFailStreak();

        return token;
    } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
            const next = await bumpRefreshFailStreak();
            if (next >= REFRESH_FAIL_THRESHOLD) {
                await clearToken();
                await clearUser();
                await clearRefreshFailStreak();
            }
        }
        console.error('[Popup] Token refresh error:', error);
        return null;
    }
}

async function authenticatedFetch(url, options = {}) {
    const response = await failoverFetch(url, options);
    if (response.status !== 401 && response.status !== 403) {
        return response;
    }

    const token = await refreshAccessToken();
    if (!token) {
        return response;
    }

    const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token}` };
    return failoverFetch(url, { ...options, headers });
}

async function clearToken() {
    return chrome.storage.local.remove(['jwtToken', 'refreshToken', 'proxyAccess']);
}

async function saveUser(user) {
    return chrome.storage.local.set({ user: user });
}

async function getUser() {
    const result = await chrome.storage.local.get('user');
    return result.user;
}

async function clearUser() {
    return chrome.storage.local.remove('user');
}

async function getProxyStatus() {
    const result = await chrome.storage.local.get('proxyEnabled');
    return result.proxyEnabled || false;
}

async function getRuntimeProxyStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
        if (!response?.success || !response.data) {
            return { enabled: await getProxyStatus(), detail: 'Статус доступен частично.' };
        }

        const { enabled, mode } = response.data;

        if (enabled) {
            const modeLabel = mode === 'whitelist' ? 'режим: выбранные сайты' : 'режим: все сайты';
            return { enabled, detail: `Подключено, ${modeLabel}.` };
        }

        return { enabled, detail: 'Используется прямое подключение.' };
    } catch (error) {
        console.warn('[Popup] Failed to query runtime proxy status:', error);
        return { enabled: await getProxyStatus(), detail: 'Не удалось получить состояние фонового процесса.' };
    }
}

/**
 * Proxy Mode & Whitelist Management
 */

// Get proxy mode
async function getProxyMode() {
    const result = await chrome.storage.local.get('proxyMode');
    return result.proxyMode || 'all';
}

// Save proxy mode
async function saveProxyMode(mode) {
    await chrome.storage.local.set({ proxyMode: mode });
    try {
        await chrome.runtime.sendMessage({ action: 'updateProxyMode', mode });
    } catch (error) {
        console.error('[Popup] Error sending updateProxyMode message:', error);
    }
}

// Get URL whitelist
async function getUrlWhitelist() {
    const result = await chrome.storage.local.get('urlWhitelist');
    return result.urlWhitelist || [];
}

// Save URL whitelist
async function saveUrlWhitelist(urls) {
    const normalizedUrls = normalizeWhitelist(urls);
    await chrome.storage.local.set({ urlWhitelist: normalizedUrls });

    try {
        await chrome.runtime.sendMessage({ action: 'updateWhitelist', urls: normalizedUrls });
    } catch (error) {
        console.error('[Popup] Error sending updateWhitelist message:', error);
    }

    const pushed = await pushServerWhitelist(normalizedUrls);
    if (!pushed) {
        showNotificationBanner({
            type: 'warning',
            message: 'Локальный список сохранён, но серверную копию обновить не удалось.'
        });
    }

    return normalizedUrls;
}

// Fetch user's whitelist from backend
async function fetchServerWhitelist() {
    try {
        const token = await getToken();
        if (!token) return null;
        const response = await authenticatedFetch(`${API_BASE_URL}/whitelist`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        if (!response.ok) {
            console.warn('[Popup] Failed to fetch server whitelist:', response.status);
            return null;
        }
        const data = await response.json();
        if (data && Array.isArray(data.urls)) {
            return data.urls;
        }
        return [];
    } catch (e) {
        console.error('[Popup] fetchServerWhitelist error:', e);
        return null;
    }
}

// Push user's whitelist to backend
async function pushServerWhitelist(urls) {
    try {
        const token = await getToken();
        if (!token) return false;
        const response = await authenticatedFetch(`${API_BASE_URL}/whitelist`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ urls })
        });
        if (!response.ok) {
            const text = await response.text();
            console.warn('[Popup] Failed to push server whitelist:', response.status, text);
            return false;
        }
        return true;
    } catch (e) {
        console.error('[Popup] pushServerWhitelist error:', e);
        return false;
    }
}

// Handle mode change
async function handleModeChange(e) {
    const mode = e.target.value;
    await saveProxyMode(mode);

    const runtimeStatus = await getRuntimeProxyStatus();
    updateProxyStatus(runtimeStatus.enabled, runtimeStatus.detail);
    
    // Show/hide whitelist section
    if (mode === 'whitelist') {
        whitelistSection.classList.remove('hidden');
        await loadUrlWhitelist();
    } else {
        whitelistSection.classList.add('hidden');
    }
}

// Load proxy mode
async function loadProxyMode() {
    const mode = await getProxyMode();
    
    if (mode === 'all') {
        modeAll.checked = true;
        whitelistSection.classList.add('hidden');
    } else {
        modeWhitelist.checked = true;
        whitelistSection.classList.remove('hidden');
    }
}

function resetUrlForm() {
    urlInput.value = '';
    urlInput.focus();
}

function normalizeUrl(url) {
    if (!url) return '';

    let normalized = url.trim().toLowerCase();
    if (!normalized) return '';

    const hasWildcardPrefix = normalized.startsWith('*.');
    const wildcardPrefix = hasWildcardPrefix ? '*.' : '';

    if (hasWildcardPrefix) {
        normalized = normalized.slice(2);
    }

    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
        try {
            normalized = new URL(normalized).hostname.toLowerCase();
        } catch (e) {
            const match = normalized.match(/^https?:\/\/([^/?#]+)/);
            if (match) {
                normalized = match[1].toLowerCase();
            }
        }
    }

    normalized = normalized
        .replace(/^[^a-z0-9*.-]+/i, '')
        .replace(/[:/?#].*$/, '')
        .replace(/\.+$/, '');

    if (!normalized) return '';
    return `${wildcardPrefix}${normalized}`;
}

function normalizeWhitelist(urls) {
    const uniqueUrls = [];
    const seen = new Set();

    for (const rawUrl of urls || []) {
        const normalized = normalizeUrl(rawUrl);
        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        uniqueUrls.push(normalized);
    }

    return uniqueUrls;
}

// Handle add URL
async function handleAddUrl() {
    const url = urlInput.value.trim();
    
    if (!url) {
        showNotificationBanner({ type: 'warning', message: 'Введите URL или домен.' });
        return;
    }
    
    if (!isValidUrlPattern(url)) {
        showNotificationBanner({
            type: 'warning',
            message: 'Неверный формат URL. Примеры: example.com, *.example.com, https://example.com/*'
        });
        return;
    }
    
    const normalizedUrl = normalizeUrl(url);
    
    if (!normalizedUrl) {
        showNotificationBanner({ type: 'warning', message: 'Не удалось извлечь домен из URL.' });
        return;
    }
    
    const whitelist = await getUrlWhitelist();
    
    if (whitelist.some(w => normalizeUrl(w) === normalizedUrl)) {
        showTransientMessage('Этот домен уже есть в списке.', 'info');
        return;
    }
    
    const relatedDomains = getRelatedDomains(normalizedUrl);

    setButtonBusy(saveUrlBtn, true, 'Сохраняем...');
    try {
        const nextWhitelist = normalizeWhitelist([...whitelist, normalizedUrl, ...relatedDomains]);
        const savedWhitelist = await saveUrlWhitelist(nextWhitelist);

        resetUrlForm();
        await loadUrlWhitelist();

        const relatedCount = Math.max(savedWhitelist.length - whitelist.length - 1, 0);
        if (relatedCount > 0) {
            showTransientMessage(`Сайт добавлен. Автоматически добавлено ещё ${relatedCount} связанных доменов.`, 'success', 5000);
        } else {
            showTransientMessage('Сайт добавлен в список.', 'success');
        }
    } finally {
        setButtonBusy(saveUrlBtn, false);
    }
}

// Get related domains for popular sites
function getRelatedDomains(domain) {
    const relatedDomainsMap = {
        'youtube.com': [
            '*.youtube.com',
            'googlevideo.com',
            '*.googlevideo.com',
            'ytimg.com',
            '*.ytimg.com',
            'googleapis.com',
            '*.googleapis.com'
        ],
        'google.com': [
            '*.google.com',
            'googleapis.com',
            '*.googleapis.com',
            'gstatic.com',
            '*.gstatic.com'
        ],
        'github.com': [
            '*.github.com',
            'githubusercontent.com',
            '*.githubusercontent.com'
        ]
    };
    
    // Strip www. prefix for lookup
    let lookupDomain = domain;
    if (domain.startsWith('www.')) {
        lookupDomain = domain.slice(4);
    }
    
    // Check exact match
    if (relatedDomainsMap[lookupDomain]) {
        return relatedDomainsMap[lookupDomain];
    }
    
    // Check if domain is a subdomain of known domains
    for (const [mainDomain, related] of Object.entries(relatedDomainsMap)) {
        if (lookupDomain.endsWith('.' + mainDomain) || lookupDomain === mainDomain) {
            return related;
        }
    }
    
    return [];
}

// Validate URL pattern
function isValidUrlPattern(url) {
    // Allow:
    // - example.com
    // - *.example.com
    // - https://example.com
    // - https://example.com/*
    const pattern = /^(\*\.)?([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$|^https?:\/\/(\*\.)?([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$/;
    return pattern.test(url);
}

// Load and display URL whitelist
async function loadUrlWhitelist() {
    const whitelist = await getUrlWhitelist();

    urlList.replaceChildren();

    if (whitelist.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.textContent = 'Нет добавленных сайтов';
        urlList.appendChild(emptyState);
        return;
    }

    for (const url of whitelist) {
        const item = document.createElement('div');
        item.className = 'url-item';

        const text = document.createElement('span');
        text.className = 'url-item-text';
        text.textContent = url;

        const button = document.createElement('button');
        button.className = 'url-item-remove';
        button.type = 'button';
        button.setAttribute('aria-label', `Удалить ${url}`);
        button.addEventListener('click', () => handleRemoveUrl(url));

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');

        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', '18');
        line1.setAttribute('y1', '6');
        line1.setAttribute('x2', '6');
        line1.setAttribute('y2', '18');

        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', '6');
        line2.setAttribute('y1', '6');
        line2.setAttribute('x2', '18');
        line2.setAttribute('y2', '18');

        icon.append(line1, line2);
        button.appendChild(icon);
        item.append(text, button);
        urlList.appendChild(item);
    }
}

async function handleRemoveUrl(url) {
    const whitelist = await getUrlWhitelist();
    const filtered = normalizeWhitelist(whitelist.filter(u => u !== url));
    await saveUrlWhitelist(filtered);
    await loadUrlWhitelist();
    showTransientMessage(`"${url}" удалён из списка.`, 'info');
}

/**
 * Load subscription information
 */
async function loadSubscription() {
    try {
        const token = await getToken();
        if (!token) return;
        
        const response = await authenticatedFetch(`${API_BASE_URL}/billing/subscription`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            console.error('[Popup] Failed to load subscription:', response.status);
            if (response.status === 401 || response.status === 403) {
                await disableProxyAccessForInactiveSubscription();
                showNoSubscription();
            } else {
                showSubscriptionUnavailable();
            }
            return;
        }
        
        const data = await response.json();
        
        if (data.has_active && data.subscription) {
            await chrome.storage.local.set({ proxyAccess: true });
            showActiveSubscription(data.subscription, data.days_remaining);
        } else {
            await disableProxyAccessForInactiveSubscription();
            showNoSubscription();
        }
    } catch (error) {
        console.error('[Popup] Error loading subscription:', error);
        showSubscriptionUnavailable();
    } finally {
        await loadPricing();
    }
}

/**
 * Load pricing information
 */
async function loadPricing() {
    try {
        const response = await failoverFetch(`${API_BASE_URL}/billing/pricing`);
        
        if (!response.ok) {
            console.error('[Popup] Failed to load pricing:', response.status);
            return;
        }
        
        const data = await response.json();
        
        // Update prices in UI
        if (data.plans) {
            data.plans.forEach(plan => {
                const priceEl = document.getElementById(`price-${plan.period}`);
                if (priceEl) {
                    priceEl.textContent = `${plan.price.toFixed(2)} ₽`;
                }
                const extendPriceEl = document.getElementById(`extend-price-${plan.period}`);
                if (extendPriceEl) {
                    extendPriceEl.textContent = `${plan.price.toFixed(2)} ₽`;
                }
            });
        }
    } catch (error) {
        console.error('[Popup] Error loading pricing:', error);
    }
}

/**
 * Show active subscription
 */
function showSubscriptionLoading() {
    subscriptionActive.classList.add('hidden');
    subscriptionInactive.classList.add('hidden');
}

function showActiveSubscription(subscription, daysRemaining) {
    subscriptionActive.classList.remove('hidden');
    subscriptionInactive.classList.add('hidden');
    
    // Format end date
    const endDate = new Date(subscription.end_date);
    const formattedDate = endDate.toLocaleDateString('ru-RU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    
    subscriptionEndDate.textContent = formattedDate;
    subscriptionDaysLeft.textContent = daysRemaining;
}

/**
 * Show no subscription state
 */
function showNoSubscription() {
    subscriptionActive.classList.add('hidden');
    subscriptionInactive.classList.remove('hidden');
    applySelectedPeriodVisual();

    const messageTitle = subscriptionInactive.querySelector('.subscription-message p');
    const messageText = subscriptionInactive.querySelector('.subscription-message small');
    if (messageTitle) {
        messageTitle.textContent = 'У вас нет активной подписки';
    }
    if (messageText) {
        messageText.textContent = 'Оформите подписку для доступа к VPS серверу';
    }
}

function showSubscriptionUnavailable() {
    subscriptionActive.classList.add('hidden');
    subscriptionInactive.classList.remove('hidden');
    applySelectedPeriodVisual();

    const messageTitle = subscriptionInactive.querySelector('.subscription-message p');
    const messageText = subscriptionInactive.querySelector('.subscription-message small');
    if (messageTitle) {
        messageTitle.textContent = 'Не удалось проверить подписку';
    }
    if (messageText) {
        messageText.textContent = 'Сервер временно недоступен. Попробуйте позже.';
    }
}

async function disableProxyAccessForInactiveSubscription() {
    await chrome.storage.local.set({ proxyAccess: false });

    try {
        const proxyEnabled = await getProxyStatus();
        if (proxyEnabled) {
            const response = await chrome.runtime.sendMessage({ action: 'disable' });
            if (response?.success) {
                updateProxyStatus(false);
            }
        }
    } catch (error) {
        console.warn('[Popup] Failed to disable proxy without active subscription:', error);
    }
}

/**
 * Handle buy/extend subscription
 */
async function handleBuySubscription() {
    setButtonBusy(buySubscriptionBtn, true, 'Создание...');
    setButtonBusy(extendSubscriptionBtn, true, 'Создание...');
    try {
        const token = await getToken();
        if (!token) {
            showNotificationBanner({ type: 'warning', message: 'Необходима авторизация.' });
            return;
        }
        
        showLoading();
        
        // Create payment
        const response = await authenticatedFetch(`${API_BASE_URL}/billing/payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                period: selectedPeriod
            })
        }).catch(err => {
            console.error('[Popup] Fetch error (network):', err);
            console.error('[Popup] Error name:', err.name);
            console.error('[Popup] Error message:', err.message);
            throw err;
        });
        
        hideLoading();
        
        if (!response.ok) {
            const contentType = response.headers.get('content-type');
            
            let errorMessage = 'Unknown error';
            if (contentType && contentType.includes('application/json')) {
                try {
                    const error = await response.json();
                    errorMessage = error.error || 'Unknown error';
                } catch (e) {
                    console.error('[Popup] Failed to parse error JSON:', e);
                    const text = await response.text();
                    console.error('[Popup] Error response text:', text);
                    errorMessage = text.substring(0, 200);
                }
            } else {
                const text = await response.text();
                console.error('[Popup] Error response text:', text);
                errorMessage = text.substring(0, 200);
            }
            
            showNotificationBanner({
                type: 'error',
                message: `Ошибка создания платежа: ${errorMessage}`
            });
            return;
        }
        
        const payment = await response.json();
        
        // Open payment URL in new tab
        if (payment.confirmation_url) {
            chrome.tabs.create({ url: payment.confirmation_url });
            showNotificationBanner({
                type: 'success',
                message: `Платёж создан: ${payment.amount} ₽ за ${payment.period} мес. Страница оплаты открыта в новой вкладке.`
            });
        } else {
            showNotificationBanner({
                type: 'error',
                message: 'Ошибка: не получена ссылка на оплату.'
            });
        }
    } catch (error) {
        hideLoading();
        console.error('[Popup] Error creating payment:', error);
        showNotificationBanner({
            type: 'error',
            message: `Ошибка при создании платежа: ${error.message}`
        });
    } finally {
        setButtonBusy(buySubscriptionBtn, false);
        setButtonBusy(extendSubscriptionBtn, false);
    }
}

// Initialize when popup opens
document.addEventListener('DOMContentLoaded', init);
