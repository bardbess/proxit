const PORT = process.env.PORT || 3000;
const PROXY_ORIGIN_COOKIE = '__proxit_upstream_origin';
const DEFAULT_UPSTREAM_DOH_URL = 'https://dns.google/resolve';
const DIRECT_RESOURCE_HOSTS = [
    'accounts.google.com',
    'apis.google.com',
    'www.google.com',
    'www.gstatic.com',
    'www.recaptcha.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'ajax.googleapis.com',
];

const BYPASS_ALL_UPSTREAM_HOSTS = process.env.UPSTREAM_HOST_OVERRIDES === '*';
const UPSTREAM_DOH_URL = process.env.UPSTREAM_DOH_URL || (BYPASS_ALL_UPSTREAM_HOSTS ? DEFAULT_UPSTREAM_DOH_URL : '');
const DEBUG_PROXY = process.env.DEBUG_PROXY === '1';
const UPSTREAM_HOST_OVERRIDES = new Set(
    (process.env.UPSTREAM_HOST_OVERRIDES || '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
);

module.exports = {
    PORT,
    PROXY_ORIGIN_COOKIE,
    DEFAULT_UPSTREAM_DOH_URL,
    DIRECT_RESOURCE_HOSTS,
    BYPASS_ALL_UPSTREAM_HOSTS,
    UPSTREAM_DOH_URL,
    DEBUG_PROXY,
    UPSTREAM_HOST_OVERRIDES,
};
