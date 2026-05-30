
import { proxyManager } from './proxy-manager.js';
import { PROXY_CONFIG } from './proxy-config.js';
import {
  checkActiveSubscription,
  getAuthState,
  getJWTToken,
  verifyTokenStatus
} from './auth-api.js';
import { isConfiguredAuthUrl, markProxyFallback } from '../shared/endpoint-manager.js';
import { recordIncident } from '../shared/diag-log.js';

let jwtTokenCache = null;
let proxyAccessCache = false;
let tokenLoadPromise = null;
let lastProxyError = null;

const SUBSCRIPTION_FAIL_STREAK_KEY = 'subscriptionFailStreak';
const SUBSCRIPTION_FAIL_LIMIT = 5;
const PAC_REBUILD_THROTTLE_MS = 30 * 1000;
let lastPacRebuildAt = 0;

// Загружаем токен при старте service worker и сохраняем Promise
function loadToken() {
  if (!tokenLoadPromise) {
    tokenLoadPromise = (async () => {
      try {
        jwtTokenCache = await getJWTToken();
      } catch (e) {
        console.error('[Service Worker] Ошибка загрузки токена:', e);
      }
      return jwtTokenCache;
    })();
  }
  return tokenLoadPromise;
}

async function refreshTokenCache() {
  try {
    jwtTokenCache = await getJWTToken();
    tokenLoadPromise = Promise.resolve(jwtTokenCache);
  } catch (e) {
    console.error('[Service Worker] Ошибка обновления токена:', e);
    jwtTokenCache = null;
    tokenLoadPromise = Promise.resolve(null);
  }

  return jwtTokenCache;
}

async function readCachedProxyAccess() {
  try {
    const stored = await chrome.storage.local.get('proxyAccess');
    return stored.proxyAccess === true;
  } catch {
    return false;
  }
}

/**
 * Gate to enable proxy. Tri-state aware:
 *   - definite negative results (invalid token / inactive sub) block
 *   - 'unreachable' falls back to the cached proxyAccess flag so a transient
 *     server hiccup doesn't kick the user out
 */
async function ensureAuthenticatedForProxy() {
  let token = await refreshTokenCache();
  if (!token) {
    return { allowed: false, error: 'Требуется авторизация' };
  }

  const verifyResult = await verifyTokenStatus(token);
  if (verifyResult === 'invalid') {
    return { allowed: false, error: 'Требуется авторизация' };
  }
  // 'valid' or 'unreachable' → продолжаем

  token = await refreshTokenCache();
  if (!token) {
    return { allowed: false, error: 'Требуется авторизация' };
  }

  const subResult = await checkActiveSubscription(token);
  if (subResult === 'inactive') {
    return { allowed: false, error: 'Требуется активная подписка' };
  }
  if (subResult === 'unauthorized') {
    return { allowed: false, error: 'Требуется авторизация' };
  }
  if (subResult === 'unreachable') {
    const cached = await readCachedProxyAccess();
    if (!cached) {
      return { allowed: false, error: 'Сервер недоступен. Попробуйте позже.' };
    }
    // Cached access → пускаем, бэкенд всё равно проверит на каждом запросе.
  }

  return { allowed: true };
}

// Запускаем загрузку сразу
loadToken();
chrome.storage.local.get('proxyAccess').then(({ proxyAccess }) => {
  proxyAccessCache = proxyAccess === true;
});

const AUTH_STATE_KEY = 'auth_flow_state';
const AUTH_ALARM = 'auth_flow_state_expire';
const SUBSCRIPTION_CHECK_ALARM = 'subscription_check';
const SUBSCRIPTION_CHECK_PERIOD_MINUTES = 15;

function syncRuntimeProxyState(config) {
  const mode = config?.value?.mode;
  const actuallyEnabled = mode === 'fixed_servers' || mode === 'pac_script';

  if (actuallyEnabled !== proxyManager.isEnabled) {
    console.warn('[Service Worker] Рассинхронизация состояния! Исправляю...');
    proxyManager.isEnabled = actuallyEnabled;
  }

  if (PROXY_CONFIG.showBadge) {
    proxyManager.updateBadge(actuallyEnabled);
  }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.jwtToken) {
    jwtTokenCache = changes.jwtToken.newValue;
    // Сбрасываем promise чтобы следующий loadToken() вернул актуальный токен
    tokenLoadPromise = Promise.resolve(jwtTokenCache);
  }

  if (namespace === 'local' && changes.proxyAccess) {
    proxyAccessCache = changes.proxyAccess.newValue === true;
  }
});

chrome.webRequest.onAuthRequired.addListener(
  function(details, callback) {
    // Игнорируем не-прокси запросы
    if (!details.isProxy) {
      if (callback) callback({});
      return;
    }

    // Ждём загрузки токена перед ответом (решает race condition).
    // ВАЖНО: даём bearer всегда, когда токен есть. Прокси-сервер сам
    // отвергнет запрос 407, если подписка реально неактивна. Раньше
    // мы делали callback({cancel:true}) при любом сомнении в proxyAccess —
    // это приводило к каскадному обрыву всех вкладок при единичной ошибке
    // /api/billing/subscription. Теперь cancel — только когда токена нет.
    loadToken().then((token) => {
      if (token) {
        callback({
          authCredentials: {
            username: 'Bearer',
            password: token
          }
        });
      } else {
        console.warn('[Service Worker] ⚠️ onAuthRequired без токена, отменяем запрос');
        callback({ cancel: true });
      }
    }).catch(() => {
      callback({ cancel: true });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  function(details) {
    try {
      const url = new URL(details.url);
      const isAuthAPI = isConfiguredAuthUrl(url);

      if (isAuthAPI) {
        const hasProxyAuth = details.requestHeaders.some(h => h.name.toLowerCase() === 'proxy-authorization');
        if (hasProxyAuth) {
          details.requestHeaders = details.requestHeaders.filter(h => h.name.toLowerCase() !== 'proxy-authorization');
        }

        return { requestHeaders: details.requestHeaders };
      }

      // Для HTTPS прокси-аутентификация выполняется один раз во время CONNECT
      // через chrome.webRequest.onAuthRequired (см. слушатель выше). Заголовок
      // Proxy-Authorization, добавленный сюда, отправляется уже внутри TLS
      // и до прокси не доходит — это лишний CPU-оверхед на каждом запросе
      // (а у YouTube/стрима их сотни в секунду).
      if (url.protocol === 'https:') {
        return { requestHeaders: details.requestHeaders };
      }
    } catch (e) {
      console.warn('[Service Worker] Не удалось распарсить URL (возможно CONNECT)');
    }

    const hasProxyAuth = details.requestHeaders.some(
      header => header.name.toLowerCase() === 'proxy-authorization'
    );

    if (hasProxyAuth) {
      return { requestHeaders: details.requestHeaders };
    }

    // Для HTTP добавляем заголовок если есть токен. Кеш proxyAccess
    // больше не блокирует header — прокси-сервер сам решит. Это убирает
    // кейс "транзиентная ошибка billing → весь HTTP-трафик уходит без auth".
    if (jwtTokenCache && proxyManager.shouldProxyUrl(details.url)) {
      details.requestHeaders.push({
        name: 'Proxy-Authorization',
        value: `Bearer ${jwtTokenCache}`
      });
    }

    return { requestHeaders: details.requestHeaders };
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

function scheduleSubscriptionCheck() {
  chrome.alarms.create(SUBSCRIPTION_CHECK_ALARM, {
    periodInMinutes: SUBSCRIPTION_CHECK_PERIOD_MINUTES
  });
}

async function getSubscriptionFailStreak() {
  const stored = await chrome.storage.local.get(SUBSCRIPTION_FAIL_STREAK_KEY);
  const value = Number(stored[SUBSCRIPTION_FAIL_STREAK_KEY] || 0);
  return Number.isFinite(value) ? value : 0;
}

async function setSubscriptionFailStreak(value) {
  if (value <= 0) {
    await chrome.storage.local.remove(SUBSCRIPTION_FAIL_STREAK_KEY);
  } else {
    await chrome.storage.local.set({ [SUBSCRIPTION_FAIL_STREAK_KEY]: value });
  }
}

async function checkSubscriptionBackground() {
  if (!proxyManager.isEnabled) return;

  try {
    const token = await getJWTToken();
    if (!token) {
      // Токена нет вообще — выключаем. Это терминальное состояние, не транзиент.
      console.warn('[Service Worker] Фоновая проверка: токен отсутствует, отключаем прокси');
      await recordIncident('background-disable', { reason: 'no-token' });
      await proxyManager.disableProxy();
      return;
    }

    const result = await checkActiveSubscription(token);

    if (result === 'active') {
      await setSubscriptionFailStreak(0);
      console.log('[Service Worker] Фоновая проверка: подписка активна');
      return;
    }

    if (result === 'inactive') {
      // Подписка реально закончилась — выключаем сразу.
      await setSubscriptionFailStreak(0);
      console.warn('[Service Worker] Фоновая проверка: inactive, отключаем прокси');
      await recordIncident('background-disable', { reason: result });
      await proxyManager.disableProxy();
      return;
    }

    // 'unauthorized' и 'unreachable' могут быть транзиентными. Поэтому здесь
    // не рвём прокси после одного 401/403 от auth/billing или сетевого сбоя,
    // а ждём несколько подряд отказов.
    const next = (await getSubscriptionFailStreak()) + 1;
    if (next >= SUBSCRIPTION_FAIL_LIMIT) {
      console.warn(`[Service Worker] Фоновая проверка: ${next} подряд ${result}, отключаем прокси`);
      await recordIncident('background-disable', { reason: `${result}-streak`, streak: next });
      await setSubscriptionFailStreak(0);
      await proxyManager.disableProxy();
    } else {
      await setSubscriptionFailStreak(next);
      console.warn(`[Service Worker] Фоновая проверка: ${result} (${next}/${SUBSCRIPTION_FAIL_LIMIT}), оставляем прокси включённым`);
    }
  } catch (e) {
    // Совсем неожиданная ошибка — не дёргаем пользователя.
    console.error('[Service Worker] Ошибка фоновой проверки подписки:', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleSubscriptionCheck();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleSubscriptionCheck();
});

chrome.action.onClicked.addListener(async () => {
  try {
    if (!proxyManager.isEnabled) {
      const access = await ensureAuthenticatedForProxy();
      if (!access.allowed) {
        lastProxyError = access.error;
        return;
      }
    }

    await proxyManager.toggleProxy();
  } catch (error) {
    console.error('[Service Worker] Ошибка при toggle:', error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {
        case 'getStatus':
          const status = proxyManager.getStatus();
          sendResponse({ success: true, data: { ...status, lastError: lastProxyError } });
          break;

        case 'toggleProxy':
          if (proxyManager.isEnabled) {
            lastProxyError = null;
            const disabledState = await proxyManager.toggleProxy();
            sendResponse({ success: true, enabled: disabledState });
            break;
          }

          const access = await ensureAuthenticatedForProxy();
          if (!access.allowed) {
            sendResponse({ success: false, error: access.error });
            break;
          }

          lastProxyError = null;
          const newState = await proxyManager.toggleProxy();
          sendResponse({ success: true, enabled: newState });
          break;

        case 'toggle':
          if (!proxyManager.isEnabled) {
            const accessToggle = await ensureAuthenticatedForProxy();
            if (!accessToggle.allowed) {
              sendResponse({ success: false, error: accessToggle.error });
              break;
            }
          }

          lastProxyError = null;
          const toggleState = await proxyManager.toggleProxy();
          sendResponse({ success: true, enabled: toggleState });
          break;

        case 'enable':
          const accessEnable = await ensureAuthenticatedForProxy();

          if (!accessEnable.allowed) {
            sendResponse({ success: false, error: accessEnable.error });
            break;
          }

          lastProxyError = null;
          await proxyManager.enableProxy();
          sendResponse({ success: true, enabled: true });
          break;

        case 'disable':
          lastProxyError = null;
          await proxyManager.disableProxy();
          sendResponse({ success: true, enabled: false });
          break;

        case 'updateProxyMode':
          await proxyManager.updateProxyMode(request.mode);
          sendResponse({ success: true });
          break;

        case 'updateWhitelist':
          await proxyManager.updateWhitelist(request.urls);
          sendResponse({ success: true });
          break;

        case 'authState:scheduleExpire':
          if (request.when && typeof request.when === 'number') {
            await chrome.alarms.clear(AUTH_ALARM);
            chrome.alarms.create(AUTH_ALARM, { when: request.when });
          }
          sendResponse({ success: true });
          break;

        case 'authState:clear':
          await chrome.storage.session.remove(AUTH_STATE_KEY);
          await chrome.alarms.clear(AUTH_ALARM);
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('[Service Worker] Ошибка обработки сообщения:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTH_ALARM) {
    try {
      await chrome.storage.session.remove(AUTH_STATE_KEY);
    } catch (e) {
      console.error('[Service Worker] Failed to clear auth state on alarm:', e);
    }
  }

  if (alarm.name === SUBSCRIPTION_CHECK_ALARM) {
    await checkSubscriptionBackground();
  }
});

chrome.proxy.onProxyError.addListener((details) => {
  if (!details) {
    lastProxyError = 'unknown';
    return;
  }

  lastProxyError = details.error || 'unknown';
  recordIncident('proxy-error', { error: details.error, fatal: details.fatal }).catch(() => {});

  // Переключаем активный endpoint и пересобираем PAC, чтобы браузер
  // начал ходить через запасной сервер сразу же. Троттлим, чтобы
  // циклические ошибки не зацикливали нас в бесконечной перезагрузке PAC.
  const now = Date.now();
  if (now - lastPacRebuildAt < PAC_REBUILD_THROTTLE_MS) {
    return;
  }
  lastPacRebuildAt = now;

  (async () => {
    try {
      const switched = await markProxyFallback();
      if (switched) {
        await proxyManager.refreshPacIfEnabled();
      }
    } catch (error) {
      console.warn('[Service Worker] Failed to mark proxy fallback:', error);
    }
  })();
});

chrome.proxy.settings.onChange.addListener(syncRuntimeProxyState);
chrome.proxy.settings.get({}, syncRuntimeProxyState);
