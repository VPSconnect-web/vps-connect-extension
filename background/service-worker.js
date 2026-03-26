
import { proxyManager } from './proxy-manager.js';
import { PROXY_CONFIG } from './proxy-config.js';
import { getJWTToken, isAuthenticated } from './auth-api.js';

let jwtTokenCache = null;
let tokenLoadPromise = null;

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

// Запускаем загрузку сразу
loadToken();

const AUTH_STATE_KEY = 'auth_flow_state';
const AUTH_ALARM = 'auth_flow_state_expire';

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.jwtToken) {
    jwtTokenCache = changes.jwtToken.newValue;
    // Сбрасываем promise чтобы следующий loadToken() вернул актуальный токен
    tokenLoadPromise = Promise.resolve(jwtTokenCache);
  }
});

chrome.webRequest.onAuthRequired.addListener(
  function(details, callback) {
    // Игнорируем не-прокси запросы
    if (!details.isProxy) {
      if (callback) callback({});
      return;
    }
    
    // Ждём загрузки токена перед ответом (решает race condition)
    loadToken().then((token) => {
      if (token) {
        callback({
          authCredentials: {
            username: 'Bearer',
            password: token
          }
        });
      } else {
        // Токена нет - отменяем запрос чтобы браузер НЕ показывал диалог
        console.warn('[Service Worker] ⚠️ Прокси-аутентификация без токена, отменяем запрос');
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
      const expectedPort = String(PROXY_CONFIG.authAPI?.port ?? '');
      const isAuthAPI = url.hostname === PROXY_CONFIG.authAPI?.host && url.port === expectedPort;
      
      if (isAuthAPI) {
        const hasProxyAuth = details.requestHeaders.some(h => h.name.toLowerCase() === 'proxy-authorization');
        if (hasProxyAuth) {
          details.requestHeaders = details.requestHeaders.filter(h => h.name.toLowerCase() !== 'proxy-authorization');
        }
        
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
    
    if (jwtTokenCache) {
      details.requestHeaders.push({
        name: 'Proxy-Authorization',
        value: `Bearer ${jwtTokenCache}`
      });
    } else {
      console.warn('[Service Worker] ⚠️ JWT токен отсутствует для исходящего запроса');
    }
    
    return { requestHeaders: details.requestHeaders };
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onInstalled.addListener(() => {
  // без лишних логов, т.к. событие не несёт чувствительные данные
});

chrome.runtime.onStartup.addListener(() => {
  // без логов
});

chrome.action.onClicked.addListener(async () => {
  try {
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
          sendResponse({ success: true, data: status });
          break;
          
        case 'toggleProxy':
          if (proxyManager.isEnabled) {
            const disabledState = await proxyManager.toggleProxy();
            sendResponse({ success: true, enabled: disabledState });
            break;
          }

          const isAuth = await isAuthenticated();
          if (!isAuth) {
            sendResponse({ success: false, error: 'Требуется авторизация' });
            break;
          }

          const newState = await proxyManager.toggleProxy();
          sendResponse({ success: true, enabled: newState });
          break;
          
        case 'toggle':
          const toggleState = await proxyManager.toggleProxy();
          sendResponse({ success: true, enabled: toggleState });
          break;
          
        case 'enable':
          const isAuthEnable = await isAuthenticated();
          
          if (!isAuthEnable) {
            sendResponse({ success: false, error: 'Требуется авторизация' });
            break;
          }
          
          await proxyManager.enableProxy();
          sendResponse({ success: true, enabled: true });
          break;
          
        case 'disable':
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
});

chrome.proxy.onProxyError.addListener((details) => {
  if (!details) {
    console.error('[Service Worker] ❌ Ошибка прокси: неизвестная ошибка');
    return;
  }
  
  console.error('[Service Worker] ❌ Ошибка прокси:', details.error || 'unknown');
  if (typeof details.fatal !== 'undefined') {
    console.error('[Service Worker] Fatal:', details.fatal);
  }
});


setInterval(() => {
  chrome.proxy.settings.get({}, (config) => {
    const mode = config.value.mode;
    
    const actuallyEnabled = (mode === 'fixed_servers' || mode === 'pac_script');
    
    if (actuallyEnabled !== proxyManager.isEnabled) {
      console.warn('[Service Worker] Рассинхронизация состояния! Исправляю...');
      proxyManager.isEnabled = actuallyEnabled;
      proxyManager.updateBadge(actuallyEnabled);
    }
  });
}, 30000);
