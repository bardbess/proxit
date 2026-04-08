const express = require('express');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const app = express();
const PORT = process.env.PORT || 3000;
const BYPASS_ALL_UPSTREAM_HOSTS = process.env.UPSTREAM_HOST_OVERRIDES === '*';
const DEFAULT_UPSTREAM_DOH_URL = 'https://dns.google/resolve';
const UPSTREAM_DOH_URL = process.env.UPSTREAM_DOH_URL || (BYPASS_ALL_UPSTREAM_HOSTS ? DEFAULT_UPSTREAM_DOH_URL : '');
const UPSTREAM_HOST_OVERRIDES = new Set(
    (process.env.UPSTREAM_HOST_OVERRIDES || '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
);

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
    return html.replace(
        /(src|href|action)=["']([^"']*?)["']/gi,
        (match, attr, path) => `${attr}="${rewriteUrlValue(path, baseUrl)}"`
    );
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

async function fetchUpstream(targetUrl) {
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const bypassHostsFile = shouldBypassHostsFile(url.hostname);
    const requestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ProxyDemo/1.0)',
        },
    };

    if (bypassHostsFile) {
        const address = await resolveUpstreamAddress(url.hostname);

        requestOptions.hostname = address;
        requestOptions.servername = url.hostname;
        requestOptions.headers.Host = url.host;
    }

    return new Promise((resolve, reject) => {
        const upstreamRequest = transport.request(requestOptions, (upstreamResponse) => {
            const chunks = [];
            upstreamResponse.on('data', (chunk) => {
                chunks.push(chunk);
            });
            upstreamResponse.on('end', () => {
                const body = Buffer.concat(chunks);
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
        upstreamRequest.end();
    });
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
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;

    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
        return res.status(400).send('Invalid or missing URL parameter');
    }

    try {
        const response = await fetchUpstream(targetUrl);

        if (!response.ok) {
            return res.status(response.status).send(`Error fetching page: ${response.statusText}`);
        }

        let contentType = response.headers['content-type'] || 'text/html';
        let body = response.body;

        // Only process HTML pages
        if (contentType.includes('text/html')) {
            const baseUrl = new URL(targetUrl);
            let html = body.toString('utf8');

            html = rewriteHtmlResourceUrls(html, baseUrl);

            // You can add more advanced rewriting here (e.g., for <script src>, CSS urls, etc.)
            body = Buffer.from(html, 'utf8');
        } else if (contentType.includes('text/css')) {
            const baseUrl = new URL(targetUrl);
            const css = rewriteCssResourceUrls(body.toString('utf8'), baseUrl);
            body = Buffer.from(css, 'utf8');
        }

        // Forward relevant headers (but strip dangerous ones)
        res.setHeader('Content-Type', contentType);

        // Remove / override anti-iframe headers
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
                // Only forward safe headers
                if (['content-type', 'content-length', 'last-modified', 'etag'].includes(lowerKey)) {
                    res.setHeader(key, value);
                }
            }
        });

        res.send(body);

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
