
import { PROXY_CONFIG } from './proxy-config.js';

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
        this.isEnabled = false;
        await chrome.storage.local.set({ proxyEnabled: false });
        await this.disableProxy();
      }
    });
  }

  async init() {
    try {
      this.setupStorageListener();

      const result = await chrome.storage.local.get(['proxyEnabled', 'proxyMode', 'urlWhitelist', 'jwtToken']);
      this.isEnabled = result.proxyEnabled ?? PROXY_CONFIG.autoEnable;
      this.proxyMode = result.proxyMode ?? 'all';
      this.urlWhitelist = result.urlWhitelist ?? [];
      this.updateWhitelistCache(this.urlWhitelist);

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
  
  /**
   * Update proxy mode
   */
  async updateProxyMode(mode) {
    this.proxyMode = mode;
    
    if (this.isEnabled) {
      await this.enableProxy();
    }
  }
  
  /**
   * Update URL whitelist
   */
  async updateWhitelist(urls) {
    this.urlWhitelist = urls;
    this.updateWhitelistCache(urls);
    
    if (this.isEnabled && this.proxyMode === 'whitelist') {
      await this.enableProxy();
    }
  }
  
  /**
   * Update in-memory whitelist cache for fast lookups
   */
  updateWhitelistCache(urls) {
    this.whitelistCache.clear();
    if (urls && Array.isArray(urls)) {
      urls.forEach(url => {
        this.whitelistCache.set(url.toLowerCase(), true);
      });
    }
  }

  async enableProxy() {
    try {
      let proxyConfig;
      
      if (this.proxyMode === 'whitelist') {
        const pacScript = this.generatePacScript();
        proxyConfig = {
          mode: "pac_script",
          pacScript: {
            data: pacScript
          }
        };
      } else {
        proxyConfig = {
          mode: "fixed_servers",
          rules: {
            singleProxy: {
              scheme: PROXY_CONFIG.scheme,
              host: PROXY_CONFIG.host,
              port: PROXY_CONFIG.port
            },
            bypassList: PROXY_CONFIG.bypassList
          }
        };
      }

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
      this.showNotification('Подключено к серверу', `${PROXY_CONFIG.host}:${PROXY_CONFIG.port}\n${mode}`);
      
    } catch (error) {
      console.error('[ProxyManager] Ошибка подключения:', error);
      this.showNotification('Ошибка', 'Не удалось подключиться к серверу');
      throw error;
    }
  }
  
  /**
   * Convert domain to Punycode (for PAC script compatibility)
   */
  toPunycode(domain) {
    try {
      // If domain contains non-ASCII characters, convert to Punycode
      if (/[^\x00-\x7F]/.test(domain)) {
        // Use URL API to convert to Punycode
        const url = new URL(`http://${domain}`);
        return url.hostname;
      }
      return domain;
    } catch (e) {
      // If conversion fails, return original domain
      console.warn('[ProxyManager] Punycode conversion failed', e);
      return domain;
    }
  }

  /**
   * Escape string for PAC script (remove non-ASCII characters from comments)
   */
  escapeForPAC(str) {
    // Remove non-ASCII characters from string (keep only ASCII)
    return str.replace(/[^\x00-\x7F]/g, '');
  }

  /**
   * Generate PAC script for whitelist mode
   */
  generatePacScript() {
    const pacProxyToken = (() => {
      const s = (PROXY_CONFIG.scheme || 'http').toLowerCase();
      if (s === 'socks5') return 'SOCKS5';
      if (s === 'socks' || s === 'socks4') return 'SOCKS';
      return 'PROXY';
    })();
    const proxyString = `${pacProxyToken} ${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`;
    const bypassList = PROXY_CONFIG.bypassList || [];
    
    if (this.urlWhitelist.length === 0) {
      return `
function FindProxyForURL(url, host) {
  return "DIRECT";
}`.trim();
    }
    
    // Create pattern matching conditions for whitelist
    const whitelistConditions = this.urlWhitelist.map(pattern => {
      // Normalize pattern: remove protocol and path, convert to lowercase
      let normalizedPattern = pattern.trim().toLowerCase();
      normalizedPattern = normalizedPattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      
      // Convert to Punycode if needed
      normalizedPattern = this.toPunycode(normalizedPattern);
      
      if (normalizedPattern.startsWith('*.')) {
        // Wildcard subdomain: *.example.com
        const domain = normalizedPattern.slice(2); // Remove *.
        // Match: example.com, www.example.com, mail.example.com, etc.
        const conditions = [
          `host.toLowerCase() == "${domain}"`,        // Exact match: example.com
          `dnsDomainIs(host, ".${domain}")`           // All subdomains: .example.com (with leading dot!)
        ];
        return `(${conditions.join(' || ')})`;
      } else if (normalizedPattern.includes('*')) {
        // Other wildcards (e.g., google.*, *google*)
        return `shExpMatch(host.toLowerCase(), "${normalizedPattern}")`;
      } else {
        // Exact domain: example.com or www.example.com
        // For www. subdomains, only do exact match (subdomains handled by *.domain.com wildcards)
        // For root domains, match both exact and subdomains
        if (normalizedPattern.startsWith('www.')) {
          // Only exact match for www. subdomains
          return `host.toLowerCase() == "${normalizedPattern}"`;
        } else {
          // Match: example.com AND all subdomains (www.example.com, mail.example.com, etc.)
          const conditions = [
            `host.toLowerCase() == "${normalizedPattern}"`,  // Exact match: example.com
            `dnsDomainIs(host, ".${normalizedPattern}")`     // All subdomains: .example.com (note the leading dot!)
          ];
          
          return `(${conditions.join(' || ')})`;
        }
      }
    }).join(' || ');
    
    // Create bypass conditions
    const bypassConditions = bypassList.map(pattern => {
      const cleanPattern = this.toPunycode(pattern);
      if (pattern.includes('/')) {
        // IP with subnet
        return `isInNet(host, "${pattern.split('/')[0]}", "${pattern.split('/')[1] || '255.255.255.255'}")`;
      } else if (pattern.includes(':')) {
        // Host with port - extract just the host part for PAC script
        // PAC script's 'host' variable doesn't include port
        const hostOnly = pattern.split(':')[0];
        return `host == "${hostOnly}"`;
      } else {
        return `dnsDomainIs(host, "${cleanPattern}") || host == "${cleanPattern}"`;
      }
    }).join(' || ');
    
    // PAC script must contain only ASCII characters
    const pacScript = `
function FindProxyForURL(url, host) {
  ${bypassConditions ? `if (${bypassConditions}) {
    return "DIRECT";
  }` : ''}
  
  if (${whitelistConditions}) {
    return "${proxyString}";
  }
  
  return "DIRECT";
}`.trim();
    
    // Validate that PAC script contains only ASCII
    if (!/^[\x00-\x7F]*$/.test(pacScript)) {
      console.error('[ProxyManager] PAC script contains non-ASCII characters!');
    }
    
    return pacScript;
  }

  async disableProxy() {
    try {
      const directConfig = {
        mode: "direct"
      };

      await chrome.proxy.settings.set({
        value: directConfig,
        scope: 'regular'
      });

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
        host: PROXY_CONFIG.host,
        port: PROXY_CONFIG.port,
        scheme: PROXY_CONFIG.scheme
      }
    };
  }

  updateBadge(enabled) {
    if (enabled) {
      chrome.action.setBadgeText({ text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      chrome.action.setTitle({ 
        title: `VPS Connect: ПОДКЛЮЧЕНО\n${PROXY_CONFIG.host}:${PROXY_CONFIG.port}\n(кликните для отключения)` 
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
