const TARGET_URL_STORAGE_KEY = 'proxit:last-target-url';

function normalizeTargetUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    const withProtocol = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;

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
    if (!url) {
        alert('Enter a URL');
        return;
    }

    url = normalizeTargetUrl(url);
    persistTargetUrl(url);

    const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;
    const iframe = document.getElementById('proxyFrame');

    iframe.src = proxyUrl;

    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = 'Loading...';
    document.querySelector('.header').appendChild(status);

    iframe.onload = () => {
        const activeUrl = getUpstreamUrlFromIframe() || url;
        persistTargetUrl(activeUrl);
        status.textContent = `Loaded: ${activeUrl}`;
        setTimeout(() => status.remove(), 3000);
    };
}

document.getElementById('loadButton').addEventListener('click', loadIframe);

document.getElementById('targetUrl').addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        loadIframe();
    }
});

window.addEventListener('load', () => {
    document.getElementById('targetUrl').value = getInitialTargetUrl();
    setTimeout(loadIframe, 500);
});
