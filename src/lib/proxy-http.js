const http = require('node:http');
const https = require('node:https');

const { PORT, PROXY_ORIGIN_COOKIE } = require('../config');
const { debugLog } = require('./logging');
const { resolveUpstreamAddress } = require('./upstream-resolver');
const {
    injectProxyBaseTag,
    injectProxyClientShim,
    rewriteCssResourceUrls,
    rewriteHtmlResourceUrls,
    rewriteLocationHeader,
    rewriteSetCookieHeader,
} = require('./content-rewriter');
const {
    getProxyOrigin,
    shouldBypassHostsFile,
    unwrapProxyUrl,
} = require('./url-utils');

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

function rewriteUpstreamRequestContextUrl(value, req, targetUrl) {
    if (!value) {
        return null;
    }

    try {
        const parsedValue = new URL(value, getProxyOrigin(req));
        const proxyOrigin = getProxyOrigin(req);

        if (parsedValue.origin === proxyOrigin && parsedValue.pathname === '/proxy') {
            const upstreamUrl = parsedValue.searchParams.get('url');
            if (upstreamUrl) {
                return unwrapProxyUrl(upstreamUrl, proxyOrigin);
            }
        }

        if (parsedValue.origin === proxyOrigin) {
            const storedUpstreamOrigin = getStoredUpstreamOrigin(req);
            if (storedUpstreamOrigin) {
                return new URL(`${parsedValue.pathname}${parsedValue.search}`, storedUpstreamOrigin).href;
            }
        }

        return new URL(value).href;
    } catch {
        try {
            return new URL(value, targetUrl.origin).href;
        } catch {
            return null;
        }
    }
}

function buildUpstreamHeaders(req, targetUrl, body) {
    const headers = { ...req.headers };
    const incomingCookies = parseCookies(req);
    const upstreamReferer = rewriteUpstreamRequestContextUrl(req.headers.referer, req, targetUrl);
    const upstreamOrigin = rewriteUpstreamRequestContextUrl(req.headers.origin, req, targetUrl);

    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    delete headers.origin;
    delete headers.referer;

    for (const headerName of Object.keys(headers)) {
        const lowerHeaderName = headerName.toLowerCase();
        if (lowerHeaderName.startsWith('sec-fetch-') || lowerHeaderName.startsWith('sec-ch-')) {
            delete headers[headerName];
        }
    }

    if (!headers['user-agent']) {
        headers['user-agent'] = 'Mozilla/5.0 (compatible; ProxyIFrame/1.0)';
    }

    headers['accept-encoding'] = 'identity';

    if (upstreamReferer) {
        headers.referer = upstreamReferer;
    }

    if (upstreamOrigin) {
        headers.origin = upstreamOrigin;
    }

    const forwardedCookies = Object.entries(incomingCookies)
        .filter(([name]) => name !== PROXY_ORIGIN_COOKIE)
        .map(([name, value]) => `${name}=${value}`);

    if (forwardedCookies.length > 0) {
        headers.cookie = forwardedCookies.join('; ');
    } else {
        delete headers.cookie;
    }

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
            'User-Agent': 'Mozilla/5.0 (compatible; ProxyIFrame/1.0)',
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
        const unwrappedTargetUrl = unwrapProxyUrl(req.query.url, getProxyOrigin(req));

        try {
            const targetUrl = new URL(unwrappedTargetUrl);
            const submittedParams = new URLSearchParams(req.query);
            submittedParams.delete('url');

            for (const [key, value] of submittedParams.entries()) {
                targetUrl.searchParams.append(key, value);
            }

            return targetUrl.href;
        } catch {
            return unwrappedTargetUrl;
        }
    }

    if (req.path !== '/proxy' && typeof req.query.url === 'string' && req.query.url) {
        try {
            const hintedUrl = new URL(unwrapProxyUrl(req.query.url, getProxyOrigin(req)));
            const requestUrl = new URL(req.originalUrl, hintedUrl.origin);

            debugLog('derived hinted-origin target', {
                method: req.method,
                originalUrl: req.originalUrl,
                hintedOrigin: hintedUrl.origin,
                resolvedUrl: requestUrl.href,
            });

            return requestUrl.href;
        } catch {
            // Fall through to referer/cookie-based mapping.
        }
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
        if (req.path === '/proxy') {
            const proxyRequestUrl = new URL(req.originalUrl, getProxyOrigin(req));
            const derivedUrl = new URL(upstreamBaseUrl.href);
            const submittedParams = new URLSearchParams(proxyRequestUrl.search);
            submittedParams.delete('url');
            derivedUrl.search = submittedParams.toString() ? `?${submittedParams.toString()}` : '';
            debugLog('derived proxy target from referer page', {
                method: req.method,
                originalUrl: req.originalUrl,
                referer,
                derivedUrl: derivedUrl.href,
            });
            return derivedUrl.href;
        }

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

function globalizeClassicScriptHelpers(javascript) {
    return javascript
        .replace(/\bconst ready =/g, 'window.ready =')
        .replace(/\bconst ajax =/g, 'window.ajax =')
        .replace(/\bconst \$ =/g, 'window.$ =');
}

function normalizeUpstreamTargetUrl(targetUrl, storedUpstreamOrigin) {
    let target = new URL(targetUrl);

    if (
        storedUpstreamOrigin &&
        (target.hostname === 'localhost' || target.hostname === '127.0.0.1') &&
        String(target.port || PORT) === String(PORT)
    ) {
        target = new URL(`${target.pathname}${target.search}`, storedUpstreamOrigin);
    }

    if (
        target.protocol === 'http:' &&
        target.port === String(PORT) &&
        target.hostname !== 'localhost' &&
        target.hostname !== '127.0.0.1'
    ) {
        target = new URL(target.href);
        target.port = '';
    }

    return target;
}

async function proxyRequest(req, res, targetUrl) {
    const requestBody = await readRequestBody(req);
    const storedUpstreamOrigin = getStoredUpstreamOrigin(req);
    const proxyOrigin = getProxyOrigin(req);
    const originalTargetUrl = targetUrl;
    let target = normalizeUpstreamTargetUrl(targetUrl, storedUpstreamOrigin);

    if (storedUpstreamOrigin && target.href !== originalTargetUrl) {
        debugLog('remapped self-proxy target', {
            originalTargetUrl,
            remappedTargetUrl: target.href,
        });
    }

    if (!storedUpstreamOrigin && target.href !== originalTargetUrl) {
        debugLog('stripped leaked proxy port from upstream target', {
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
    const targetPathname = new URL(target.href).pathname.toLowerCase();

    if ((targetPathname.endsWith('.js') || targetPathname.endsWith('.mjs')) && (!contentType || contentType.startsWith('text/plain'))) {
        contentType = 'application/javascript; charset=utf-8';
    }

    const shouldGlobalizeClassicHelpers =
        response.status >= 200 &&
        response.status < 300 &&
        contentType.includes('javascript') &&
        req.path !== '/proxy';

    if (contentType.includes('text/html')) {
        const baseUrl = new URL(target.href);
        let html = body.toString('utf8');

        html = injectProxyBaseTag(html, baseUrl);
        html = rewriteHtmlResourceUrls(html, baseUrl, proxyOrigin);
        html = injectProxyClientShim(html, proxyOrigin);
        body = Buffer.from(html, 'utf8');
        bodyWasRewritten = true;
        res.cookie(PROXY_ORIGIN_COOKIE, encodeURIComponent(target.origin), {
            httpOnly: false,
            sameSite: 'lax',
            path: '/',
        });
    } else if (shouldGlobalizeClassicHelpers) {
        const javascript = globalizeClassicScriptHelpers(body.toString('utf8'));
        body = Buffer.from(javascript, 'utf8');
        bodyWasRewritten = true;
    } else if (response.status >= 200 && response.status < 300 && contentType.includes('text/css')) {
        const baseUrl = new URL(target.href);
        const css = rewriteCssResourceUrls(body.toString('utf8'), baseUrl, proxyOrigin);
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
        'content-security-policy-report-only',
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

                if (bodyWasRewritten && lowerKey === 'cache-control') {
                    return;
                }

                if (bodyWasRewritten && lowerKey === 'expires') {
                    return;
                }

                if ((targetPathname.endsWith('.js') || targetPathname.endsWith('.mjs')) && lowerKey === 'x-content-type-options') {
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
                    const rewrittenLocation = rewriteLocationHeader(value, target.href, proxyOrigin);
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

    if (bodyWasRewritten) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Expires', '0');
    }

    if (response.status === 304 || req.method === 'HEAD') {
        res.end();
        return;
    }

    res.send(body);
}

module.exports = {
    buildUpstreamHeaders,
    getProxyTargetUrl,
    globalizeClassicScriptHelpers,
    normalizeUpstreamTargetUrl,
    proxyRequest,
    rewriteUpstreamRequestContextUrl,
};
