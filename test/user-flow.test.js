import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repoRoot = new URL('../', import.meta.url);

function runScenario(source) {
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: repoRoot,
    input: source,
    encoding: 'utf8'
  });

  assert.equal(
    result.status,
    0,
    [
      'Scenario failed',
      result.stdout,
      result.stderr
    ].filter(Boolean).join('\n')
  );
}

function scenario(body) {
  return `
    import assert from 'node:assert/strict';

    const listeners = {
      storageChanged: [],
      runtimeMessage: [],
      runtimeInstalled: [],
      runtimeStartup: [],
      actionClicked: [],
      authRequired: [],
      beforeSendHeaders: [],
      proxyError: [],
      proxySettingsChanged: [],
      alarms: []
    };
    const storageData = {};
    const calls = {
      proxySettingsSet: [],
      badgeText: [],
      badgeColor: [],
      title: [],
      alarmsCreated: []
    };

    function clone(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function emitStorageChange(changes) {
      for (const listener of listeners.storageChanged) {
        listener(changes, 'local');
      }
    }

    function createEvent(name) {
      return {
        addListener(listener) {
          listeners[name].push(listener);
        }
      };
    }

    globalThis.chrome = {
      storage: {
        local: {
          async get(keys) {
            if (keys == null) return clone(storageData);
            if (typeof keys === 'string') return { [keys]: clone(storageData[keys]) };
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map(key => [key, clone(storageData[key])]));
            }
            return Object.fromEntries(
              Object.entries(keys).map(([key, defaultValue]) => [
                key,
                storageData[key] === undefined ? defaultValue : clone(storageData[key])
              ])
            );
          },
          async set(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              const oldValue = clone(storageData[key]);
              if (JSON.stringify(oldValue) === JSON.stringify(value)) {
                continue;
              }
              storageData[key] = clone(value);
              changes[key] = { oldValue, newValue: clone(value) };
            }
            if (Object.keys(changes).length > 0) {
              emitStorageChange(changes);
            }
          },
          async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            const changes = {};
            for (const key of list) {
              if (!(key in storageData)) {
                continue;
              }
              const oldValue = clone(storageData[key]);
              delete storageData[key];
              changes[key] = { oldValue, newValue: undefined };
            }
            if (Object.keys(changes).length > 0) {
              emitStorageChange(changes);
            }
          }
        },
        session: {
          async remove() {}
        },
        onChanged: createEvent('storageChanged')
      },
      proxy: {
        settings: {
          async set(config) {
            calls.proxySettingsSet.push(clone(config));
          },
          get(_details, callback) {
            callback({ value: calls.proxySettingsSet.at(-1)?.value || { mode: 'direct' } });
          },
          onChange: createEvent('proxySettingsChanged')
        },
        onProxyError: createEvent('proxyError')
      },
      action: {
        setBadgeText(value) { calls.badgeText.push(clone(value)); },
        setBadgeBackgroundColor(value) { calls.badgeColor.push(clone(value)); },
        setTitle(value) { calls.title.push(clone(value)); },
        onClicked: createEvent('actionClicked')
      },
      webRequest: {
        onAuthRequired: createEvent('authRequired'),
        onBeforeSendHeaders: createEvent('beforeSendHeaders')
      },
      runtime: {
        onInstalled: createEvent('runtimeInstalled'),
        onStartup: createEvent('runtimeStartup'),
        onMessage: createEvent('runtimeMessage'),
        async sendMessage(message) {
          let response;
          await listeners.runtimeMessage[0](message, {}, value => { response = value; });
          await new Promise(resolve => setTimeout(resolve, 0));
          return response;
        }
      },
      alarms: {
        async clear() {},
        create(name, options) {
          calls.alarmsCreated.push({ name, options: clone(options) });
        },
        onAlarm: createEvent('alarms')
      }
    };

    const responses = [];
    globalThis.fetch = async (url, options = {}) => {
      const next = responses.shift();
      if (!next) {
        throw new Error('Unexpected fetch: ' + url);
      }
      if (next.assert) next.assert(String(url), options);
      if (next.error) throw next.error;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' }
      });
    };

    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const importFresh = path => import(new URL(path + '?t=' + Date.now() + Math.random(), '${repoRoot.href}'));

    ${body}
  `;
}

test('user with active subscription can enable proxy and gets proxy auth credentials', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: false
    });
    responses.push(
      { body: { id: 1, email: 'user@example.com' } },
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 10 } },
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 10 } }
    );

    await importFresh('background/service-worker.js');
    await flush();

    const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
    assert.deepEqual(response, { success: true, enabled: true });
    assert.equal(storageData.proxyEnabled, true);
    assert.equal(storageData.proxyAccess, true);
    assert.equal(calls.proxySettingsSet.at(-1).value.mode, 'pac_script');
    assert.match(calls.proxySettingsSet.at(-1).value.pacScript.data, /PROXY vpsconecttech\\.ru:18183/);

    let authResponse;
    listeners.authRequired[0]({ isProxy: true }, value => { authResponse = value; });
    await flush();
    assert.deepEqual(authResponse, {
      authCredentials: {
        username: 'Bearer',
        password: 'active-token'
      }
    });
  `));
});

test('proxy chain coerces unsupported schemes to HTTP proxy tokens', () => {
  runScenario(`
    import assert from 'node:assert/strict';
    import { PROXY_CONFIG } from './background/proxy-config.js';
    import { getProxyChain } from './shared/endpoint-manager.js';

    PROXY_CONFIG.endpoints = [{
      id: 'primary',
      label: 'Primary',
      host: '108.165.174.119',
      port: 18183,
      scheme: 'socks5',
      authAPI: {
        host: '108.165.174.119',
        port: 18184,
        baseURL: 'http://108.165.174.119:18184'
      }
    }];

    assert.equal(getProxyChain(), 'PROXY 108.165.174.119:18183');
  `);
});

test('expired subscription blocks proxy enable and lets backend reject via Bearer', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'expired-token',
      isAuthenticated: true,
      proxyEnabled: false
    });
    // ensureAuthenticatedForProxy: verifyTokenStatus + checkActiveSubscription
    responses.push(
      { body: { id: 1, email: 'user@example.com' } },
      { body: { has_active: false, subscription: null, days_remaining: 0 } }
    );

    await importFresh('background/service-worker.js');
    await flush();

    const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
    assert.deepEqual(response, { success: false, error: 'Требуется активная подписка' });
    assert.equal(storageData.proxyEnabled, false);
    assert.equal(storageData.proxyAccess, false);
    assert.equal(calls.proxySettingsSet.at(-1).value.mode, 'direct');

    // onAuthRequired теперь даёт Bearer всегда, когда токен есть. Прокси-сервер
    // сам отвергает запрос, если подписка неактивна. Старое поведение (cancel:true)
    // приводило к каскадным сбоям при единичной ошибке billing API.
    let authResponse;
    listeners.authRequired[0]({ isProxy: true }, value => { authResponse = value; });
    await flush();
    assert.deepEqual(authResponse, {
      authCredentials: { username: 'Bearer', password: 'expired-token' }
    });
  `));
});

test('proxy-manager init does not make network calls and trusts cached state', () => {
  // init() больше не дёргает API — иначе одна ошибка сети при пробуждении
  // service worker роняет сессию. Проверка подписки теперь только в alarm.
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'stale-token',
      isAuthenticated: true,
      proxyEnabled: true,
      proxyAccess: true
    });
    // No responses pushed → ANY fetch during init throws 'Unexpected fetch'.

    await importFresh('background/proxy-manager.js');
    await flush();
    await flush();

    // Кешированный proxyEnabled сохраняется, а не сбрасывается.
    assert.equal(storageData.proxyEnabled, true);
    assert.equal(storageData.proxyAccess, true);
    assert.equal(calls.proxySettingsSet.at(-1).value.mode, 'pac_script');
  `));
});

test('unauthenticated user cannot enable proxy', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      proxyEnabled: false
    });

    await importFresh('background/service-worker.js');
    await flush();

    const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
    assert.deepEqual(response, { success: false, error: 'Требуется авторизация' });
    assert.equal(storageData.proxyEnabled, false);
    assert.equal(calls.proxySettingsSet.at(-1).value.mode, 'direct');
  `));
});

test('auth API requests never receive Proxy-Authorization header', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyAccess: true,
      proxyEnabled: false
    });
    responses.push(
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 10 } }
    );

    await importFresh('background/service-worker.js');
    await flush();

    const result = listeners.beforeSendHeaders[0]({
      url: 'http://vpsconecttech.ru:18184/api/billing/subscription',
      requestHeaders: [
        { name: 'Proxy-Authorization', value: 'Bearer leaked-token' },
        { name: 'Accept', value: 'application/json' }
      ]
    });

    assert.deepEqual(result.requestHeaders, [
      { name: 'Accept', value: 'application/json' }
    ]);
  `));
});

test('HTTP requests receive Proxy-Authorization while proxy is enabled and skip bypass hosts', () => {
  // Источник правды для проверки подписки — прокси-сервер. Расширение
  // добавляет Bearer на все http-запросы, идущие через прокси. Если подписка
  // истекла, сервер сам ответит 407 — нам не нужно дублировать решение
  // в расширении (это и был источник «вылетающих сессий»).
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyAccess: true,
      proxyEnabled: false
    });
    responses.push(
      { body: { id: 1, email: 'user@example.com' } },
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 10 } }
    );

    await importFresh('background/service-worker.js');
    await flush();
    const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
    assert.equal(response.success, true);

    const activeResult = listeners.beforeSendHeaders[0]({
      url: 'http://example.com/page',
      requestHeaders: []
    });
    assert.deepEqual(activeResult.requestHeaders, [
      { name: 'Proxy-Authorization', value: 'Bearer active-token' }
    ]);

    // Bypass hosts ходят напрямую — Bearer не добавляется.
    const bypassResult = listeners.beforeSendHeaders[0]({
      url: 'http://192.168.1.1/router',
      requestHeaders: []
    });
    assert.deepEqual(bypassResult.requestHeaders, []);
  `));
});

test('background alarm disables proxy when subscription expires mid-session', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: true,
      proxyAccess: true
    });

    await importFresh('background/service-worker.js');
    await flush();

    assert.equal(storageData.proxyEnabled, true, 'proxy should be enabled after init');

    // subscription expires — alarm fires
    responses.push(
      { body: { has_active: false, subscription: null, days_remaining: 0 } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();

    assert.equal(storageData.proxyEnabled, false, 'proxy should be disabled after expired subscription alarm');
    assert.equal(storageData.proxyAccess, false);
    assert.equal(calls.proxySettingsSet.at(-1).value.mode, 'direct');
  `));
});

test('background alarm keeps proxy running through transient unreachable errors', () => {
  // Один (или два) транзиентных 5xx/network не должны выкидывать пользователя
  // из сессии. Только N подряд unreachable — отключают.
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: true,
      proxyAccess: true
    });

    await importFresh('background/service-worker.js');
    await flush();

    // 1-я транзиентная ошибка
    responses.push({ status: 503, body: { error: 'unavailable' } });
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after one 503');

    // 2-я ошибка (network-style)
    responses.push({ error: new TypeError('Failed to fetch') });
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after two transient failures');

    // 3-я подряд — всё ещё держим подключение
    responses.push({ status: 502, body: { error: 'bad gateway' } });
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after three transient failures');

    responses.push({ status: 503, body: { error: 'still unavailable' } });
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after four transient failures');

    // 5-я подряд — лимит превышен, отключаем
    responses.push({ error: new TypeError('Failed to fetch again') });
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, false, 'should disable after fail streak hits limit');
  `));
});

test('background alarm keeps proxy running through transient unauthorized errors', () => {
  // Один auth-отказ на billing/refresh не должен рвать уже включённый прокси:
  // backend может временно ошибиться с токеном или репликами сессий.
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'expired-access-token',
      refreshToken: 'maybe-flaky-refresh-token',
      isAuthenticated: true,
      proxyEnabled: true,
      proxyAccess: true
    });

    await importFresh('background/service-worker.js');
    await flush();

    responses.push(
      { status: 401, body: { error: 'token expired' } },
      { status: 401, body: { error: 'refresh failed once' } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after one unauthorized check');
    assert.equal(storageData.jwtToken, 'expired-access-token', 'tokens should be retained after one refresh 401');

    responses.push(
      { status: 401, body: { error: 'token expired' } },
      { status: 401, body: { error: 'refresh failed twice' } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after two unauthorized checks');

    responses.push(
      { status: 401, body: { error: 'token expired' } },
      { status: 401, body: { error: 'refresh failed third time' } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after three unauthorized checks');
    assert.equal(storageData.jwtToken, 'expired-access-token', 'auth session should be retained before limit');

    responses.push(
      { status: 401, body: { error: 'token expired' } },
      { status: 401, body: { error: 'refresh failed fourth time' } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, true, 'should stay enabled after four unauthorized checks');

    responses.push(
      { status: 401, body: { error: 'token expired' } },
      { status: 401, body: { error: 'refresh revoked' } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();
    assert.equal(storageData.proxyEnabled, false, 'should disable after unauthorized streak hits limit');
    assert.equal(storageData.jwtToken, undefined, 'auth session should be cleared after repeated refresh 401');
  `));
});

test('background alarm keeps proxy running when subscription is still active', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: true,
      proxyAccess: true
    });

    await importFresh('background/service-worker.js');
    await flush();

    // alarm fires — subscription still active
    responses.push(
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 29 } }
    );
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();

    assert.equal(storageData.proxyEnabled, true, 'proxy should stay enabled');
    assert.equal(storageData.proxyAccess, true);
  `));
});

test('background alarm skips check when proxy is already disabled', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: false
    });

    await importFresh('background/service-worker.js');
    await flush();

    // alarm fires while proxy is off — no extra fetch should happen
    await listeners.alarms[0]({ name: 'subscription_check' });
    await flush();

    // if an unexpected fetch happened, globalThis.fetch would throw 'Unexpected fetch'
    assert.equal(storageData.proxyEnabled, false);
  `));
});

test('removing JWT token from storage auto-disables proxy', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: true,
      proxyAccess: true
    });

    await importFresh('background/service-worker.js');
    await flush();
    assert.equal(storageData.proxyEnabled, true);

    // user logs out / token revoked — storage listener fires
    await chrome.storage.local.remove(['jwtToken']);
    await flush();

    assert.equal(storageData.proxyEnabled, false, 'proxy must be disabled when token is removed');
    assert.equal(calls.proxySettingsSet.at(-1).value.mode, 'direct');
  `));
});

test('expired access token is refreshed before auth is rejected', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'expired-access-token',
      refreshToken: 'valid-refresh-token',
      isAuthenticated: true,
      proxyEnabled: false
    });

    responses.push(
      {
        status: 401,
        body: { error: 'token expired' },
        assert(url) {
          assert.match(url, /\\/api\\/auth\\/verify$/);
        }
      },
      {
        body: {
          token: 'fresh-access-token',
          refreshToken: 'rotated-refresh-token',
          user: { id: 1, email: 'user@example.com' }
        },
        assert(url, options) {
          assert.match(url, /\\/api\\/auth\\/refresh$/);
          assert.equal(JSON.parse(options.body).refreshToken, 'valid-refresh-token');
        }
      },
      {
        body: { id: 1, email: 'user@example.com' },
        assert(url, options) {
          assert.match(url, /\\/api\\/auth\\/verify$/);
          assert.equal(options.headers.Authorization, 'Bearer fresh-access-token');
        }
      }
    );

    const { isAuthenticated } = await importFresh('background/auth-api.js');
    const authenticated = await isAuthenticated();

    assert.equal(authenticated, true);
    assert.equal(storageData.jwtToken, 'fresh-access-token');
    assert.equal(storageData.refreshToken, 'rotated-refresh-token');
    assert.deepEqual(storageData.user, { id: 1, email: 'user@example.com' });
  `));
});

test('a single 401 on refresh does NOT clear the auth session', () => {
  // Регрессионный тест: один транзиентный 401 на refresh раньше мгновенно
  // выкидывал пользователя. Теперь токены чистятся только после нескольких
  // подряд подтверждённых 401 — это страхует от случайных серверных багов.
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'expired-access-token',
      refreshToken: 'maybe-flaky-refresh-token',
      user: { id: 1, email: 'user@example.com' },
      isAuthenticated: true,
      proxyAccess: true,
      proxyEnabled: false
    });

    responses.push(
      { status: 401, body: { error: 'token expired' } },
      { status: 401, body: { error: 'refresh failed once' } }
    );

    const { getAuthState } = await importFresh('background/auth-api.js');
    const state = await getAuthState();

    assert.equal(state, 'unauthenticated');
    // Токены сохраняются, чтобы повторный refresh мог сработать.
    assert.equal(storageData.jwtToken, 'expired-access-token');
    assert.equal(storageData.refreshToken, 'maybe-flaky-refresh-token');
    assert.deepEqual(storageData.user, { id: 1, email: 'user@example.com' });
  `));
});

test('five consecutive 401s on refresh clear the auth session', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'expired-access-token',
      refreshToken: 'revoked-refresh-token',
      user: { id: 1, email: 'user@example.com' },
      isAuthenticated: true,
      proxyAccess: true,
      proxyEnabled: false
    });

    // 5 циклов verify(401) + refresh(401)
    for (let i = 0; i < 5; i++) {
      responses.push(
        { status: 401, body: { error: 'token expired' } },
        { status: 401, body: { error: 'refresh revoked' } }
      );
    }

    const { getAuthState } = await importFresh('background/auth-api.js');
    await getAuthState();
    await getAuthState();
    await getAuthState();
    await getAuthState();
    await getAuthState();

    assert.equal(storageData.jwtToken, undefined);
    assert.equal(storageData.refreshToken, undefined);
    assert.equal(storageData.user, undefined);
    assert.equal(storageData.isAuthenticated, undefined);
    assert.equal(storageData.proxyAccess, undefined);
  `));
});

test('primary-only auth requests retry the main endpoint without switching to backup', () => {
  runScenario(scenario(`
    const seenUrls = [];
    const primaryUrl = 'http://vpsconecttech.ru:18184/api/auth/sessions/reset';

    responses.push(
      {
        status: 503,
        body: { error: 'unavailable-1' },
        assert(url) {
          seenUrls.push(url);
        }
      },
      {
        status: 503,
        body: { error: 'unavailable-2' },
        assert(url) {
          seenUrls.push(url);
        }
      },
      {
        status: 502,
        body: { error: 'unavailable-3' },
        assert(url) {
          seenUrls.push(url);
        }
      },
      {
        error: new TypeError('Failed to fetch'),
        assert(url) {
          seenUrls.push(url);
        }
      },
      {
        body: { success: true },
        assert(url) {
          seenUrls.push(url);
        }
      }
    );

    const { requestPrimaryJson } = await importFresh('shared/api-client.js');
    await requestPrimaryJson(primaryUrl, {
      method: 'POST',
      retryAttempts: 5
    }, 'Reset failed');

    assert.deepEqual(seenUrls, [
      primaryUrl,
      primaryUrl,
      primaryUrl,
      primaryUrl,
      primaryUrl
    ]);
  `));
});

test('whitelist mode generates PAC script routing only listed domains through proxy', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: false,
      proxyMode: 'whitelist',
      urlWhitelist: ['youtube.com', '*.netflix.com']
    });
    responses.push(
      { body: { id: 1, email: 'user@example.com' } },
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 30 } }
    );

    await importFresh('background/service-worker.js');
    await flush();

    const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
    assert.equal(response.success, true);

    const pac = calls.proxySettingsSet.at(-1).value.pacScript.data;

    // must route youtube.com and subdomains
    assert.match(pac, /youtube\\.com/);
    // must route netflix.com subdomains via wildcard
    assert.match(pac, /netflix\\.com/);
    // google.com is not in whitelist — PAC should return DIRECT for it
    // verify by checking the DIRECT fallback exists and whitelist condition is scoped
    assert.match(pac, /return "DIRECT"/);
    assert.doesNotMatch(pac, /google\\.com/);
  `));
});

test('logout clears all auth keys from storage', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      user: { id: 1, email: 'user@example.com' },
      isAuthenticated: true,
      proxyAccess: true,
      proxyEnabled: false
    });

    // init subscription check
    responses.push(
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 30 } }
    );

    const { logoutUser } = await importFresh('background/auth-api.js');
    await flush();

    // logout API call
    responses.push({ body: { success: true } });
    await logoutUser();

    assert.equal(storageData.jwtToken, undefined, 'token must be removed');
    assert.equal(storageData.user, undefined, 'user must be removed');
    assert.equal(storageData.isAuthenticated, undefined, 'isAuthenticated must be removed');
    assert.equal(storageData.proxyAccess, undefined, 'proxyAccess must be removed');
  `));
});

test('PAC script keeps configured local and private bypass rules direct', () => {
  runScenario(scenario(`
    Object.assign(storageData, {
      jwtToken: 'active-token',
      isAuthenticated: true,
      proxyEnabled: false
    });
    responses.push(
      { body: { id: 1, email: 'user@example.com' } },
      { body: { has_active: true, subscription: { end_date: '2099-01-01T00:00:00Z' }, days_remaining: 10 } }
    );

    await importFresh('background/service-worker.js');
    await flush();
    const response = await chrome.runtime.sendMessage({ action: 'toggleProxy' });
    assert.equal(response.success, true);

    const pacScript = calls.proxySettingsSet.at(-1).value.pacScript.data;
    assert.match(pacScript, /isPlainHostName\\(host\\)/);
    assert.match(pacScript, /shExpMatch\\(host\\.toLowerCase\\(\\), "192\\.168\\.\\*"\\)/);
    assert.match(pacScript, /shExpMatch\\(host\\.toLowerCase\\(\\), "10\\.\\*"\\)/);
    assert.match(pacScript, /shExpMatch\\(host\\.toLowerCase\\(\\), "\\*\\.local"\\)/);
  `));
});
