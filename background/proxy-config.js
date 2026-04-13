/**
 * Server Configuration
 *
 * Один источник правды для адресов/портов.
 * Чтобы переключить окружение — поменяйте ACTIVE_ENV.
 */

// 'stage' | 'prod' | 'local'
const ACTIVE_ENV = 'prod';

const ENVIRONMENTS = {
  stage: {
    // Proxy server address
    host: '140.235.130.26',

    // Proxy server port
    port: 18183,

    // Proxy scheme: "http", "https", "socks4", "socks5"
    scheme: 'http',

    // JWT Authentication
    auth: {
      enabled: true,
      type: 'jwt'
    },

    // Auth API server configuration
    authAPI: {
      host: '140.235.130.26',
      port: 18184,
      baseURL: 'http://140.235.130.26:18184'
    },

    // Bypass list - addresses that will NOT be proxied
    // Chrome will connect to them directly
    bypassList: [
      'localhost',
      '127.0.0.1',
      '*.local',
      '192.168.*',
      '10.*',
      '172.16.*',
      '<local>', // Chrome special notation for local addresses
      // Proxy/Auth hosts - do not proxy requests to the server itself
      '140.235.130.26'
    ],

    // Auto-enable proxy on browser startup
    // IMPORTANT: Should be false to prevent proxy from enabling without authentication
    autoEnable: false,

    // Show badge with status
    showBadge: true
  },

  prod: {
    host: '108.165.174.119',
    port: 18183,
    scheme: 'http',
    auth: {
      enabled: true,
      type: 'jwt'
    },
    authAPI: {
      host: '108.165.174.119',
      port: 18184,
      baseURL: 'http://108.165.174.119:18184'
    },
    bypassList: [
      'localhost',
      '127.0.0.1',
      '*.local',
      '192.168.*',
      '10.*',
      '172.16.*',
      '<local>',
      '108.165.174.119'
    ],
    autoEnable: false,
    showBadge: true
  },

  local: {
    host: '127.0.0.1',
    port: 18183,
    scheme: 'http',
    auth: {
      enabled: true,
      type: 'jwt'
    },
    authAPI: {
      host: '127.0.0.1',
      port: 18184,
      baseURL: 'http://127.0.0.1:18184'
    },
    bypassList: [
      'localhost',
      '127.0.0.1',
      '*.local',
      '192.168.*',
      '10.*',
      '172.16.*',
      '<local>'
    ],
    autoEnable: false,
    showBadge: true
  }
};

export const PROXY_CONFIG = ENVIRONMENTS[ACTIVE_ENV];
