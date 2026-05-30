
import { PROXY_CONFIG } from './proxy-config.js';
import {
  getActiveOrderedEndpoints,
  getActiveOrderedProxyChain,
  getEndpoints,
  getPrimaryEndpoint,
  getProxyChain
} from '../shared/endpoint-manager.js';
import { recordIncident } from '../shared/diag-log.js';

class ProxyManager {
  constructor() {
    this.isEnabled = false;
    this.proxyMode = 'all'; // 'all' or 'whitelist'
    this.urlWhitelist = []; // In-memory cache of whitelist
    this.whitelistCache = new Map(); // Fast lookup cache: domain -> true
    this.init();
  }

  setupStorageListener() {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') {
        return;
      }

      if (changes.proxyEnabled) {
        if (changes.proxyEnabled.newValue !== this.isEnabled) {
          this.isEnabled = changes.proxyEnabled.newValue;
          if (this.isEnabled) {
            const result = await chrome.storage.local.get('jwtToken');
            if (!result.jwtToken) {
              this.isEnabled = false;
              await chrome.storage.local.set({ proxyEnabled: false });
              await this.disableProxy();
              return;
            }
            await this.enableProxy();
          } else {
            await this.disableProxy();
          }
        }
      }

      if (changes.proxyMode) {
        this.proxyMode = changes.proxyMode.newValue;
        if (this.isEnabled) {
          await this.enableProxy();
        }
      }

      if (changes.urlWhitelist) {
        this.urlWhitelist = changes.urlWhitelist.newValue || [];
        this.updateWhitelistCache(this.urlWhitelist);
        if (this.isEnabled && this.proxyMode === 'whitelist') {
          await this.enableProxy();
        }
      }

      if (changes.jwtToken && !changes.jwtToken.newValue) {
        // Token cleared (logout / refresh streak exceeded). Stop proxying.
        this.isEnabled = false;
        await chrome.storage.local.set({ proxyEnabled: false });
        await this.disableProxy();
      }
    });
  }

  async init() {
    try {
      this.setupStorageListener();

      const result = await chrome.storage.local.get([
        'proxyEnabled',
        'proxyMode',
        'urlWhitelist',
        'jwtToken',
        'proxyAccess'
      ]);
      this.isEnabled = result.proxyEnabled ?? PROXY_CONFIG.autoEnable;
      this.proxyMode = result.proxyMode ?? 'all';
      this.urlWhitelist = result.urlWhitelist ?? [];
      this.updateWhitelistCache(this.urlWhitelist);

      // Critical: do NOT make network calls during init().
      // Service workers in MV3 wake up frequently and a single transient
      // server hiccup must not yank the proxy out from under the user.
      // Trust the cached proxyAccess flag; the periodic alarm in service-worker.js
      // refreshes it with proper fail-streak handling.
      if (!result.jwtToken) {
        this.isEnabled = false;
        await chrome.storage.local.set({ proxyEnabled: false });
        await this.disableProxy();
        return;
      }

      if (this.isEnabled) {
        await this.enableProxy();
      } else {
        await this.disableProxy();
      }
    } catch (error) {
      console.error('[ProxyManager] Ошибка инициализации:', error);
    }
  }

  async updateProxyMode(mode) {
    this.proxyMode = mode;

    if (this.isEnabled) {
      await this.enableProxy();
    }
  }

  async updateWhitelist(urls) {
    this.urlWhitelist = urls;
    this.updateWhitelistCache(urls);

    if (this.isEnabled && this.proxyMode === 'whitelist') {
      await this.enableProxy();
    }
  }

  updateWhitelistCache(urls) {
    this.whitelistCache.clear();
    if (urls && Array.isArray(urls)) {
      urls.forEach(url => {
        this.whitelistCache.set(url.toLowerCase(), true);
      });
    }
  }

  normalizeHostPattern(pattern) {
    let normalized = String(pattern || '').trim().toLowerCase();
    normalized = normalized.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return this.toPunycode(normalized);
  }

  wildcardMatch(value, pattern) {
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escapedPattern}$`).test(value);
  }

  hostMatchesBypass(host, pattern) {
    const normalizedPattern = this.normalizeHostPattern(pattern);

    if (!normalizedPattern) {
      return false;
    }

    if (normalizedPattern === '<local>') {
      return !host.includes('.');
    }

    if (normalizedPattern.includes('/')) {
      return false;
    }

    const hostOnly = normalizedPattern.includes(':') ? normalizedPattern.split(':')[0] : normalizedPattern;
    if (hostOnly.includes('*')) {
      return this.wildcardMatch(host, hostOnly);
    }

    return host === hostOnly || host.endsWith(`.${hostOnly}`);
  }

  hostMatchesWhitelist(host, pattern) {
    const normalizedPattern = this.normalizeHostPattern(pattern);

    if (!normalizedPattern) {
      return false;
    }

    if (normalizedPattern.startsWith('*.')) {
      const domain = normalizedPattern.slice(2);
      return host === domain || host.endsWith(`.${domain}`);
    }

    if (normalizedPattern.includes('*')) {
      return this.wildcardMatch(host, normalizedPattern);
    }

    if (normalizedPattern.startsWith('www.')) {
      return host === normalizedPattern;
    }

    return host === normalizedPattern || host.endsWith(`.${normalizedPattern}`);
  }

  shouldProxyUrl(rawUrl) {
    if (!this.isEnabled) {
      return false;
    }

    let host;
    try {
      host = new URL(rawUrl).hostname.toLowerCase();
    } catch (error) {
      return false;
    }

    const bypassList = PROXY_CONFIG.bypassList || [];
    if (bypassList.some(pattern => this.hostMatchesBypass(host, pattern))) {
      return false;
    }

    if (this.proxyMode !== 'whitelist') {
      return true;
    }

    return this.urlWhitelist.some(pattern => this.hostMatchesWhitelist(host, pattern));
  }

  async setDirectProxy() {
    await chrome.proxy.settings.set({
      value: {
        mode: "direct"
      },
      scope: 'regular'
    });
  }

  async enableProxy() {
    try {
      const proxyChain = await getActiveOrderedProxyChain();
      const pacScript = await this.generatePacScript(this.proxyMode !== 'whitelist', proxyChain);
      const proxyConfig = {
        mode: "pac_script",
        pacScript: {
          data: pacScript
        }
      };

      await chrome.proxy.settings.set({
        value: proxyConfig,
        scope: 'regular'
      });

      this.isEnabled = true;
      await chrome.storage.local.set({ proxyEnabled: true });

      if (PROXY_CONFIG.showBadge) {
        this.updateBadge(true);
      }

      const mode = this.proxyMode === 'whitelist' ? 'Выбранные сайты' : 'Все сайты';
      this.showNotification('Подключено к серверу', `${proxyChain}\n${mode}`);

    } catch (error) {
      console.error('[ProxyManager] Ошибка подключения:', error);
      try {
        await this.setDirectProxy();
        this.isEnabled = false;
        await chrome.storage.local.set({ proxyEnabled: false });

        if (PROXY_CONFIG.showBadge) {
          this.updateBadge(false);
        }
      } catch (rollbackError) {
        console.error('[ProxyManager] Ошибка отката к прямому подключению:', rollbackError);
      }
      this.showNotification('Ошибка', 'Не удалось подключиться к серверу');
      throw error;
    }
  }

  /**
   * Rebuild PAC with the latest active endpoint ordering. Used after a proxy
   * error fired chrome.proxy.onProxyError so the browser starts trying the
   * backup endpoint first.
   */
  async refreshPacIfEnabled() {
    if (!this.isEnabled) return false;
    try {
      const proxyChain = await getActiveOrderedProxyChain();
      const pacScript = await this.generatePacScript(this.proxyMode !== 'whitelist', proxyChain);
      await chrome.proxy.settings.set({
        value: { mode: 'pac_script', pacScript: { data: pacScript } },
        scope: 'regular'
      });
      await recordIncident('pac-rebuilt', { chain: proxyChain });
      return true;
    } catch (error) {
      console.warn('[ProxyManager] Не удалось пересобрать PAC:', error);
      return false;
    }
  }

  /**
   * Convert domain to Punycode (for PAC script compatibility)
   */
  toPunycode(domain) {
    try {
      if (/[^\x00-\x7F]/.test(domain)) {
        const url = new URL(`http://${domain}`);
        return url.hostname;
      }
      return domain;
    } catch (e) {
      console.warn('[ProxyManager] Punycode conversion failed', e);
      return domain;
    }
  }

  /**
   * Escape string for PAC script (remove non-ASCII characters from comments)
   */
  escapeForPAC(str) {
    return str.replace(/[^\x00-\x7F]/g, '');
  }

  /**
   * Generate PAC script for whitelist mode
   */
  async generatePacScript(routeAll = false, proxyChainOverride = null) {
    const proxyString = proxyChainOverride ?? await getActiveOrderedProxyChain();
    const bypassList = PROXY_CONFIG.bypassList || [];

    if (!routeAll && this.urlWhitelist.length === 0) {
      return `
function FindProxyForURL(url, host) {
  return "DIRECT";
}`.trim();
    }

    const whitelistConditions = this.urlWhitelist.map(pattern => {
      let normalizedPattern = pattern.trim().toLowerCase();
      normalizedPattern = normalizedPattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      normalizedPattern = this.toPunycode(normalizedPattern);

      if (normalizedPattern.startsWith('*.')) {
        const domain = normalizedPattern.slice(2);
        const conditions = [
          `host.toLowerCase() == "${domain}"`,
          `dnsDomainIs(host, ".${domain}")`
        ];
        return `(${conditions.join(' || ')})`;
      } else if (normalizedPattern.includes('*')) {
        return `shExpMatch(host.toLowerCase(), "${normalizedPattern}")`;
      } else {
        if (normalizedPattern.startsWith('www.')) {
          return `host.toLowerCase() == "${normalizedPattern}"`;
        } else {
          const conditions = [
            `host.toLowerCase() == "${normalizedPattern}"`,
            `dnsDomainIs(host, ".${normalizedPattern}")`
          ];

          return `(${conditions.join(' || ')})`;
        }
      }
    }).join(' || ') || 'false';

    const bypassConditions = bypassList.map(pattern => {
      const cleanPattern = this.toPunycode(pattern);
      if (pattern === '<local>') {
        return 'isPlainHostName(host)';
      } else if (pattern.includes('/')) {
        return `isInNet(host, "${pattern.split('/')[0]}", "${pattern.split('/')[1] || '255.255.255.255'}")`;
      } else if (pattern.includes(':')) {
        const hostOnly = pattern.split(':')[0];
        return `host == "${hostOnly}"`;
      } else if (cleanPattern.includes('*')) {
        return `shExpMatch(host.toLowerCase(), "${cleanPattern.toLowerCase()}")`;
      } else {
        return `dnsDomainIs(host, "${cleanPattern}") || host == "${cleanPattern}"`;
      }
    }).join(' || ');

    const pacScript = `
function FindProxyForURL(url, host) {
  ${bypassConditions ? `if (${bypassConditions}) {
    return "DIRECT";
  }` : ''}

  if (${routeAll ? 'true' : whitelistConditions}) {
    return "${proxyString}";
  }

  return "DIRECT";
}`.trim();

    if (!/^[\x00-\x7F]*$/.test(pacScript)) {
      console.error('[ProxyManager] PAC script contains non-ASCII characters!');
    }

    return pacScript;
  }

  async disableProxy() {
    try {
      await this.setDirectProxy();

      this.isEnabled = false;
      await chrome.storage.local.set({ proxyEnabled: false });

      if (PROXY_CONFIG.showBadge) {
        this.updateBadge(false);
      }

      this.showNotification('Отключено от сервера', 'Прямое подключение');

    } catch (error) {
      console.error('[ProxyManager] Ошибка отключения:', error);
      this.showNotification('Ошибка', 'Не удалось отключиться от сервера');
      throw error;
    }
  }

  async toggleProxy() {
    if (this.isEnabled) {
      await this.disableProxy();
    } else {
      await this.enableProxy();
    }

    return this.isEnabled;
  }

  getStatus() {
    return {
      enabled: this.isEnabled,
      mode: this.proxyMode,
      whitelistCount: this.urlWhitelist.length,
      config: {
        host: getPrimaryEndpoint().host,
        port: getPrimaryEndpoint().port,
        scheme: getPrimaryEndpoint().scheme,
        endpoints: getEndpoints().map(endpoint => ({
          id: endpoint.id,
          host: endpoint.host,
          port: endpoint.port
        }))
      }
    };
  }

  updateBadge(enabled) {
    if (enabled) {
      chrome.action.setBadgeText({ text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      chrome.action.setTitle({
        title: `VPS Connect: ПОДКЛЮЧЕНО\n${getProxyChain()}\n(кликните для отключения)`
      });
    } else {
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
      chrome.action.setTitle({
        title: 'VPS Connect: ОТКЛЮЧЕНО\n(кликните для подключения)'
      });
    }
  }

  showNotification(title, message) {
    /*
    chrome.notifications.create({
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: title,
      message: message,
      priority: 0
    });
    */
  }
}

export const proxyManager = new ProxyManager();
