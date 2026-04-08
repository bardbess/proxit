const express = require('express');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const app = express();
const PORT = process.env.PORT || 3000;
const BYPASS_ALL_UPSTREAM_HOSTS = process.env.UPSTREAM_HOST_OVERRIDES === '*';
const DEFAULT_UPSTREAM_DOH_URL = 'https://dns.google/resolve';
const UPSTREAM_DOH_URL = process.env.UPSTREAM_DOH_URL || (BYPASS_ALL_UPSTREAM_HOSTS ? DEFAULT_UPSTREAM_DOH_URL : '');
const DEBUG_PROXY = process.env.DEBUG_PROXY === '1';
const UPSTREAM_HOST_OVERRIDES = new Set(
    (process.env.UPSTREAM_HOST_OVERRIDES || '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
);
const PROXY_ORIGIN_COOKIE = '__proxit_upstream_origin';

function debugLog(message, details) {
    if (!DEBUG_PROXY) {
        return;
    }

    if (details === undefined) {
        console.log(`[proxy-debug] ${message}`);
        return;
    }

    console.log(`[proxy-debug] ${message}`, details);
}

function shouldBypassHostsFile(hostname) {
    if (BYPASS_ALL_UPSTREAM_HOSTS) {
        return true;
    }

    return UPSTREAM_HOST_OVERRIDES.has(hostname.toLowerCase());
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                headers: {
                    Accept: 'application/dns-json, application/json',
                    'User-Agent': 'Mozilla/5.0 (compatible; ProxyDemo/1.0)',
                },
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');

                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`DoH resolver returned ${response.statusCode}: ${response.statusMessage}`));
                        return;
                    }

                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        request.on('error', reject);
    });
}

async function resolveViaDoh(hostname, recordType) {
    if (!UPSTREAM_DOH_URL) {
        return null;
    }

    const dohUrl = new URL(UPSTREAM_DOH_URL);
    dohUrl.searchParams.set('name', hostname);
    dohUrl.searchParams.set('type', recordType);
    const payload = await fetchJson(dohUrl);
    const answer = Array.isArray(payload.Answer)
        ? payload.Answer.find((record) => typeof record.data === 'string')
        : null;

    return answer ? answer.data : null;
}

async function resolveUpstreamAddress(hostname) {
    for (const recordType of ['A', 'AAAA']) {
        try {
            const dohAddress = await resolveViaDoh(hostname, recordType);
            if (dohAddress) {
                return dohAddress;
            }
        } catch (error) {
            if (recordType === 'AAAA') {
                console.warn(`DoH lookup failed for ${hostname}: ${error.message}`);
            }
        }
    }

    for (const resolver of [dns.resolve4, dns.resolve6]) {
        try {
            const addresses = await resolver(hostname);
            if (addresses.length > 0) {
                return addresses[0];
            }
        } catch (error) {
            if (!['ENODATA', 'ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'EREFUSED', 'ETIMEOUT'].includes(error.code)) {
                throw error;
            }
        }
    }

    throw new Error(`Unable to resolve upstream host outside the hosts file: ${hostname}`);
}

function toProxyUrl(absoluteUrl) {
    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function shouldLeaveUrlAlone(path) {
    return (
        !path ||
        path.startsWith('data:') ||
        path.startsWith('javascript:') ||
        path.startsWith('mailto:') ||
        path.startsWith('tel:') ||
        path.startsWith('#')
    );
}

function rewriteUrlValue(path, baseUrl) {
    if (shouldLeaveUrlAlone(path)) {
        return path;
    }

    try {
        const absolute = new URL(path, baseUrl).href;
        return toProxyUrl(absolute);
    } catch {
        return path;
    }
}

function rewriteHtmlResourceUrls(html, baseUrl) {
    return html.replace(/<[^>]+>/g, (tag) => {
        if (/^<\//.test(tag)) {
            return tag;
        }

        let rewrittenTag = tag.replace(
            /\b(src|href|action)=["']([^"']*?)["']/gi,
            (match, attr, path) => `${attr}="${rewriteUrlValue(path, baseUrl)}"`
        );

        rewrittenTag = rewrittenTag.replace(/\starget=["']_blank["']/gi, ' target="_self"');
        rewrittenTag = rewrittenTag.replace(/\sintegrity=["'][^"']*["']/gi, '');
        rewrittenTag = rewrittenTag.replace(/\scrossorigin=["'][^"']*["']/gi, '');

        return rewrittenTag;
    });
}

function injectProxyClientShim(html) {
    const shim = `
<script>
(() => {
    if (window.__proxitShimInstalled) {
        return;
    }
    window.__proxitShimInstalled = true;

    const proxyOrigin = window.location.origin;
    const proxyableSchemes = /^(https?:)?\\/\\//i;
    const shouldBypass = (value) => {
        if (!value) {
            return true;
        }

        return (
            value.startsWith('data:') ||
            value.startsWith('javascript:') ||
            value.startsWith('mailto:') ||
            value.startsWith('tel:') ||
            value.startsWith('#')
        );
    };

    const toAbsoluteUrl = (value) => {
        try {
            return new URL(value, window.location.href).href;
        } catch {
            return value;
        }
    };

    const toProxyUrl = (value) => {
        if (shouldBypass(value)) {
            return value;
        }

        const absoluteUrl = toAbsoluteUrl(value);
        return '/proxy?url=' + encodeURIComponent(absoluteUrl);
    };

    const shouldProxyRequest = (value) => {
        if (!value || shouldBypass(value)) {
            return false;
        }

        const absoluteUrl = toAbsoluteUrl(value);
        if (!/^https?:/i.test(absoluteUrl)) {
            return false;
        }

        if (absoluteUrl.startsWith(proxyOrigin + '/')) {
            return false;
        }

        return true;
    };

    window.open = function(url) {
        if (url) {
            window.location.href = toProxyUrl(url);
        }
        return window;
    };

    document.addEventListener('click', (event) => {
        const link = event.target.closest && event.target.closest('a[target="_blank"]');
        if (!link) {
            return;
        }

        event.preventDefault();
        window.location.href = link.href;
    }, true);

    const originalFetch = window.fetch && window.fetch.bind(window);
    if (originalFetch) {
        window.fetch = function(input, init) {
            if (typeof input === 'string') {
                return originalFetch(shouldProxyRequest(input) ? toProxyUrl(input) : input, init);
            }

            if (input instanceof Request) {
                const requestUrl = input.url;
                if (!shouldProxyRequest(requestUrl)) {
                    return originalFetch(input, init);
                }

                const proxiedRequest = new Request(toProxyUrl(requestUrl), input);
                return originalFetch(proxiedRequest, init);
            }

            return originalFetch(input, init);
        };
    }

    const OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR) {
        const originalOpen = OriginalXHR.prototype.open;
        OriginalXHR.prototype.open = function(method, url, ...rest) {
            const proxiedUrl = shouldProxyRequest(url) ? toProxyUrl(url) : url;
            return originalOpen.call(this, method, proxiedUrl, ...rest);
        };
    }

    if (navigator.sendBeacon) {
        const originalSendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function(url, data) {
            const proxiedUrl = shouldProxyRequest(url) ? toProxyUrl(url) : url;
            return originalSendBeacon(proxiedUrl, data);
        };
    }

    const rewriteAttribute = (proto, attributeName) => {
        const descriptor = Object.getOwnPropertyDescriptor(proto, attributeName);
        if (!descriptor || !descriptor.set || !descriptor.get) {
            return;
        }

        Object.defineProperty(proto, attributeName, {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() {
                return descriptor.get.call(this);
            },
            set(value) {
                const nextValue = shouldProxyRequest(value) ? toProxyUrl(value) : value;
                descriptor.set.call(this, nextValue);
            }
        });
    };

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        const lowerName = String(name).toLowerCase();
        let nextValue = value;

        if (['src', 'href', 'action', 'srcset'].includes(lowerName) && shouldProxyRequest(String(value))) {
            nextValue = toProxyUrl(String(value));
        }

        if (lowerName === 'target' && String(value).toLowerCase() === '_blank') {
            nextValue = '_self';
        }

        return originalSetAttribute.call(this, name, nextValue);
    };

    if (window.HTMLImageElement) {
        rewriteAttribute(window.HTMLImageElement.prototype, 'src');
        rewriteAttribute(window.HTMLImageElement.prototype, 'srcset');
    }

    if (window.HTMLScriptElement) {
        rewriteAttribute(window.HTMLScriptElement.prototype, 'src');
    }

    if (window.HTMLLinkElement) {
        rewriteAttribute(window.HTMLLinkElement.prototype, 'href');
    }

    if (window.HTMLMediaElement) {
        rewriteAttribute(window.HTMLMediaElement.prototype, 'src');
    }

    if (window.HTMLSourceElement) {
        rewriteAttribute(window.HTMLSourceElement.prototype, 'src');
        rewriteAttribute(window.HTMLSourceElement.prototype, 'srcset');
    }

    if (window.HTMLAnchorElement) {
        rewriteAttribute(window.HTMLAnchorElement.prototype, 'href');
    }

    if (window.HTMLFormElement) {
        rewriteAttribute(window.HTMLFormElement.prototype, 'action');
    }

})();
</script>`;

    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>${shim}`);
    }

    if (/<body[^>]*>/i.test(html)) {
        return html.replace(/<body([^>]*)>/i, `<body$1>${shim}`);
    }

    return `${shim}${html}`;
}

function rewriteCssResourceUrls(css, baseUrl) {
    const rewrittenUrls = css.replace(
        /url\((['"]?)([^)'"]+)\1\)/gi,
        (match, quote, path) => `url(${quote}${rewriteUrlValue(path.trim(), baseUrl)}${quote})`
    );

    return rewrittenUrls.replace(
        /@import\s+(?:url\()?(['"])([^'"]+)\1\)?/gi,
        (match, quote, path) => match.replace(path, rewriteUrlValue(path.trim(), baseUrl))
    );
}

function rewriteSetCookieHeader(value) {
    const cookies = Array.isArray(value) ? value : [value];

    return cookies.map((cookie) => {
        const parts = cookie.split(';').map((part) => part.trim()).filter(Boolean);
        if (parts.length === 0) {
            return cookie;
        }

        const [nameValue, ...attributes] = parts;
        const rewrittenAttributes = [];

        for (const attribute of attributes) {
            const lowerAttribute = attribute.toLowerCase();

            if (lowerAttribute.startsWith('domain=')) {
                continue;
            }

            if (lowerAttribute === 'secure') {
                continue;
            }

            if (lowerAttribute === 'samesite=none') {
                rewrittenAttributes.push('SameSite=Lax');
                continue;
            }

            rewrittenAttributes.push(attribute);
        }

        if (!rewrittenAttributes.some((attribute) => attribute.toLowerCase().startsWith('path='))) {
            rewrittenAttributes.push('Path=/');
        }

        return [nameValue, ...rewrittenAttributes].join('; ');
    });
}

function rewriteLocationHeader(value, baseUrl) {
    if (!value) {
        return value;
    }

    try {
        return toProxyUrl(new URL(value, baseUrl).href);
    } catch {
        return value;
    }
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
        return {};
    }

    return Object.fromEntries(
        cookieHeader
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const separatorIndex = part.indexOf('=');
                if (separatorIndex === -1) {
                    return [part, ''];
                }

                return [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)];
            })
    );
}

function getStoredUpstreamOrigin(req) {
    try {
        const cookies = parseCookies(req);
        const encodedOrigin = cookies[PROXY_ORIGIN_COOKIE];
        return encodedOrigin ? decodeURIComponent(encodedOrigin) : null;
    } catch {
        return null;
    }
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function buildUpstreamHeaders(req, targetUrl, body) {
    const headers = { ...req.headers };

    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    delete headers['if-none-match'];
    delete headers['if-modified-since'];

    if (!headers['user-agent']) {
        headers['user-agent'] = 'Mozilla/5.0 (compatible; ProxyDemo/1.0)';
    }

    headers['accept-encoding'] = 'identity';

    if (body.length > 0) {
        headers['content-length'] = String(body.length);
    }

    if (shouldBypassHostsFile(targetUrl.hostname)) {
        headers.host = targetUrl.host;
    }

    return headers;
}

async function fetchUpstream(targetUrl, options = {}) {
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const bypassHostsFile = shouldBypassHostsFile(url.hostname);
    const requestBody = options.body || Buffer.alloc(0);
    const requestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: options.headers || {
            'User-Agent': 'Mozilla/5.0 (compatible; ProxyDemo/1.0)',
        },
    };

    if (bypassHostsFile) {
        const address = await resolveUpstreamAddress(url.hostname);

        requestOptions.hostname = address;
        requestOptions.servername = url.hostname;
        requestOptions.headers.Host = url.host;
        debugLog('resolved bypass host', {
            hostname: url.hostname,
            address,
            method: requestOptions.method,
            path: requestOptions.path,
        });
    }

    return new Promise((resolve, reject) => {
        const upstreamRequest = transport.request(requestOptions, (upstreamResponse) => {
            const chunks = [];
            upstreamResponse.on('data', (chunk) => {
                chunks.push(chunk);
            });
            upstreamResponse.on('end', () => {
                const body = Buffer.concat(chunks);
                debugLog('upstream response', {
                    method: requestOptions.method,
                    targetUrl,
                    status: upstreamResponse.statusCode,
                    location: upstreamResponse.headers.location,
                    setCookieCount: Array.isArray(upstreamResponse.headers['set-cookie'])
                        ? upstreamResponse.headers['set-cookie'].length
                        : (upstreamResponse.headers['set-cookie'] ? 1 : 0),
                    contentType: upstreamResponse.headers['content-type'],
                });
                resolve({
                    ok: upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300,
                    status: upstreamResponse.statusCode,
                    statusText: upstreamResponse.statusMessage,
                    headers: upstreamResponse.headers,
                    body,
                });
            });
        });

        upstreamRequest.on('error', reject);
        if (requestBody.length > 0) {
            upstreamRequest.write(requestBody);
        }
        upstreamRequest.end();
    });
}

function getProxyTargetUrl(req) {
    if (req.path === '/proxy' && typeof req.query.url === 'string' && req.query.url) {
        return req.query.url;
    }

    const referer = req.get('referer');
    if (!referer) {
        return null;
    }

    try {
        const refererUrl = new URL(referer);
        if (refererUrl.pathname !== '/proxy') {
            return null;
        }

        const upstreamPageUrl = refererUrl.searchParams.get('url');
        if (!upstreamPageUrl) {
            return null;
        }

        const upstreamBaseUrl = new URL(upstreamPageUrl);
        const resolvedUrl = new URL(req.originalUrl, upstreamBaseUrl.origin).href;
        debugLog('derived same-origin target', {
            method: req.method,
            originalUrl: req.originalUrl,
            referer,
            resolvedUrl,
        });
        return resolvedUrl;
    } catch {
        // Fall through to cookie-based origin mapping.
    }

    try {
        const upstreamOrigin = getStoredUpstreamOrigin(req);
        if (!upstreamOrigin) {
            return null;
        }

        const resolvedUrl = new URL(req.originalUrl, upstreamOrigin).href;
        debugLog('derived cookie target', {
            method: req.method,
            originalUrl: req.originalUrl,
            upstreamOrigin,
            resolvedUrl,
        });
        return resolvedUrl;
    } catch {
        return null;
    }
}

async function proxyRequest(req, res, targetUrl) {
    const requestBody = await readRequestBody(req);
    let target = new URL(targetUrl);
    const storedUpstreamOrigin = getStoredUpstreamOrigin(req);

    if (
        storedUpstreamOrigin &&
        (target.hostname === 'localhost' || target.hostname === '127.0.0.1') &&
        String(target.port || PORT) === String(PORT)
    ) {
        const originalTargetUrl = target.href;
        target = new URL(`${target.pathname}${target.search}`, storedUpstreamOrigin);
        debugLog('remapped self-proxy target', {
            originalTargetUrl,
            remappedTargetUrl: target.href,
        });
    }

    debugLog('proxy request', {
        method: req.method,
        incomingUrl: req.originalUrl,
        targetUrl: target.href,
        referer: req.get('referer'),
        contentType: req.get('content-type'),
        bodyLength: requestBody.length,
        cookiePresent: Boolean(req.get('cookie')),
    });
    const response = await fetchUpstream(target.href, {
        method: req.method,
        headers: buildUpstreamHeaders(req, target, requestBody),
        body: requestBody,
    });

    let contentType = response.headers['content-type'] || 'text/html';
    let body = response.body;
    let bodyWasRewritten = false;

    if (response.status >= 200 && response.status < 300 && contentType.includes('text/html')) {
        const baseUrl = new URL(target.href);
        let html = body.toString('utf8');

        html = rewriteHtmlResourceUrls(html, baseUrl);
        html = injectProxyClientShim(html);
        body = Buffer.from(html, 'utf8');
        bodyWasRewritten = true;
        res.cookie(PROXY_ORIGIN_COOKIE, encodeURIComponent(target.origin), {
            httpOnly: false,
            sameSite: 'lax',
            path: '/',
        });
    } else if (response.status >= 200 && response.status < 300 && contentType.includes('text/css')) {
        const baseUrl = new URL(target.href);
        const css = rewriteCssResourceUrls(body.toString('utf8'), baseUrl);
        body = Buffer.from(css, 'utf8');
        bodyWasRewritten = true;
    }

    res.status(response.status);
    res.setHeader('Content-Type', contentType);

    const forbiddenHeaders = [
        'x-frame-options',
        'content-security-policy',
        'x-content-security-policy',
        'frame-options',
        'content-security-policy-report-only'
    ];

    Object.entries(response.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (!forbiddenHeaders.includes(lowerKey) && value !== undefined) {
            if (['content-type', 'content-length', 'last-modified', 'etag', 'set-cookie', 'location', 'content-encoding', 'cache-control', 'expires', 'vary', 'x-content-type-options'].includes(lowerKey)) {
                if (bodyWasRewritten && ['content-length', 'etag', 'last-modified'].includes(lowerKey)) {
                    return;
                }

                if (bodyWasRewritten && lowerKey === 'content-encoding') {
                    return;
                }

                if (lowerKey === 'set-cookie') {
                    const rewrittenCookies = rewriteSetCookieHeader(value);
                    debugLog('rewrote set-cookie', {
                        targetUrl: target.href,
                        count: rewrittenCookies.length,
                    });
                    res.setHeader(key, rewrittenCookies);
                    return;
                }

                if (lowerKey === 'location') {
                    const rewrittenLocation = rewriteLocationHeader(value, target.href);
                    debugLog('rewrote location', {
                        from: value,
                        to: rewrittenLocation,
                    });
                    res.setHeader(key, rewrittenLocation);
                    return;
                }

                res.setHeader(key, value);
            }
        }
    });

    if (response.status !== 304 && req.method !== 'HEAD') {
        res.setHeader('Content-Length', String(body.length));
    }

    if (response.status === 304 || req.method === 'HEAD') {
        res.end();
        return;
    }

    res.send(body);
}

// Basic security headers for your own demo page
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL'); // or 'SAMEORIGIN' if you prefer
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' *;"); // allow framing
    next();
});

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Server-Side Proxy Iframe Demo</title>
    <style>
        body, html { margin:0; padding:0; height:100%; background:#0f0f0f; color:#eee; font-family:system-ui, sans-serif; }
        .container { display:flex; flex-direction:column; height:100%; }
        .header {
            background:#1a1a1a; padding:15px 20px; border-bottom:1px solid #333;
            display:flex; align-items:center; gap:15px; flex-wrap:wrap;
        }
        input[type="text"] {
            flex:1; min-width:320px; padding:10px 14px; font-size:16px;
            background:#222; color:#fff; border:1px solid #444; border-radius:6px;
        }
        button {
            padding:10px 24px; background:#0066ff; color:white; border:none;
            border-radius:6px; cursor:pointer; font-weight:bold;
        }
        button:hover { background:#3388ff; }
        iframe { flex:1; border:none; background:#fff; }
        .info {
            position:absolute; top:20px; right:20px; background:rgba(0,0,0,0.8);
            padding:8px 14px; border-radius:6px; font-size:14px; z-index:10;
        }
        .status { margin-top: 8px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2 style="margin:0;">Server-Side Proxy Iframe Demo</h2>

            <input type="text" id="targetUrl"
                   value="https://httpbin.org/html"
                   placeholder="https://example.com">

            <button onclick="loadIframe()">Load via Proxy</button>
        </div>

        <iframe id="proxyFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>
    </div>

    <div class="info">
        Server-side proxy • Bypasses X-Frame-Options & CSP
    </div>

    <script>
        async function loadIframe() {
            let url = document.getElementById('targetUrl').value.trim();
            if (!url) return alert("Enter a URL");

            if (!url.startsWith('http')) url = 'https://' + url;

            const proxyUrl = '/proxy?url=' + encodeURIComponent(url);
            const iframe = document.getElementById('proxyFrame');

            iframe.src = proxyUrl;

            // Optional: show loading status
            const status = document.createElement('div');
            status.className = 'status';
            status.textContent = 'Loading...';
            document.querySelector('.header').appendChild(status);

            iframe.onload = () => {
                status.textContent = 'Loaded: ' + url;
                setTimeout(() => status.remove(), 3000);
            };
        }

        // Enter key support
        document.getElementById('targetUrl').addEventListener('keypress', e => {
            if (e.key === 'Enter') loadIframe();
        });

        // Auto load demo on start
        window.addEventListener('load', () => {
            setTimeout(loadIframe, 500);
        });
    </script>
</body>
</html>
    `);
});

// ======================
// PROXY ROUTE
// ======================
app.all('/proxy', async (req, res) => {
    let targetUrl = req.query.url;

    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
        return res.status(400).send('Invalid or missing URL parameter');
    }

    try {
        await proxyRequest(req, res, targetUrl);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send(`
            <h2>Proxy Error</h2>
            <p>Failed to load: ${targetUrl}</p>
            <p>${error.message}</p>
            <p>Try a different URL or check your internet connection.</p>
        `);
    }
});

app.use(async (req, res, next) => {
    if (req.path === '/') {
        return next();
    }

    const targetUrl = getProxyTargetUrl(req);
    if (!targetUrl) {
        return next();
    }

    try {
        await proxyRequest(req, res, targetUrl);
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send(`
            <h2>Proxy Error</h2>
            <p>Failed to load: ${targetUrl}</p>
            <p>${error.message}</p>
            <p>Try a different URL or check your internet connection.</p>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Try: http://localhost:${PORT}/proxy?url=https://httpbin.org/html`);
});
