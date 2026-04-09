function getHomePageHtml() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Server-Side Iframe Proxy</title>
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
            <h2 style="margin:0;">Server-Side Iframe Proxy</h2>

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
        const TARGET_URL_STORAGE_KEY = 'proxit:last-target-url';

        function normalizeTargetUrl(rawValue) {
            const value = String(rawValue || '').trim();
            if (!value) {
                return '';
            }

            const withProtocol = value.startsWith('http://') || value.startsWith('https://') ? value : 'https://' + value;

            try {
                let currentUrl = new URL(withProtocol, window.location.origin);
                for (let depth = 0; depth < 5; depth += 1) {
                    if (currentUrl.origin !== window.location.origin || currentUrl.pathname !== '/proxy') {
                        return currentUrl.href;
                    }

                    const nestedUrl = currentUrl.searchParams.get('url');
                    if (!nestedUrl) {
                        return currentUrl.href;
                    }

                    currentUrl = new URL(nestedUrl, window.location.origin);
                }

                return currentUrl.href;
            } catch {
                return withProtocol;
            }
        }

        function persistTargetUrl(url) {
            const normalizedUrl = normalizeTargetUrl(url);
            if (!normalizedUrl) {
                return;
            }

            const input = document.getElementById('targetUrl');
            input.value = normalizedUrl;
            window.localStorage.setItem(TARGET_URL_STORAGE_KEY, normalizedUrl);
        }

        function getInitialTargetUrl() {
            return normalizeTargetUrl(window.localStorage.getItem(TARGET_URL_STORAGE_KEY) || 'https://httpbin.org/html');
        }

        function getUpstreamUrlFromIframe() {
            const iframe = document.getElementById('proxyFrame');

            try {
                const iframeUrl = new URL(iframe.contentWindow.location.href);
                if (iframeUrl.pathname === '/proxy') {
                    const proxiedUrl = iframeUrl.searchParams.get('url');
                    if (proxiedUrl) {
                        return proxiedUrl;
                    }
                }

                const iframeDocument = iframe.contentDocument;
                const baseElement = iframeDocument && iframeDocument.querySelector('base[data-proxit-base]');
                if (baseElement && baseElement.href) {
                    return baseElement.href;
                }

                if (/^https?:/i.test(iframeUrl.href)) {
                    return iframeUrl.href;
                }
            } catch {
                return '';
            }

            return '';
        }

        async function loadIframe() {
            let url = document.getElementById('targetUrl').value.trim();
            if (!url) return alert("Enter a URL");

            url = normalizeTargetUrl(url);
            persistTargetUrl(url);

            const proxyUrl = '/proxy?url=' + encodeURIComponent(url);
            const iframe = document.getElementById('proxyFrame');

            iframe.src = proxyUrl;

            const status = document.createElement('div');
            status.className = 'status';
            status.textContent = 'Loading...';
            document.querySelector('.header').appendChild(status);

            iframe.onload = () => {
                const activeUrl = getUpstreamUrlFromIframe() || url;
                persistTargetUrl(activeUrl);
                status.textContent = 'Loaded: ' + activeUrl;
                setTimeout(() => status.remove(), 3000);
            };
        }

        document.getElementById('targetUrl').addEventListener('keypress', e => {
            if (e.key === 'Enter') loadIframe();
        });

        window.addEventListener('load', () => {
            document.getElementById('targetUrl').value = getInitialTargetUrl();
            setTimeout(loadIframe, 500);
        });
    </script>
</body>
</html>
    `;
}

module.exports = {
    getHomePageHtml,
};
