const TARGET_URL_STORAGE_KEY = 'proxit:last-target-url';
let currentStatusTimer = null;

function getStatusElement() {
    let status = document.getElementById('loadStatus');
    if (!status) {
        status = document.createElement('div');
        status.id = 'loadStatus';
        status.className = 'status';
        status.setAttribute('aria-live', 'polite');
        status.innerHTML = '<span class="status-indicator" aria-hidden="true"></span><span class="status-text"></span>';
        document.querySelector('.header').appendChild(status);
    }

    return status;
}

function setStatus(message, state = 'idle', { autoClear = false } = {}) {
    const status = getStatusElement();
    const text = status.querySelector('.status-text');

    status.dataset.state = state;
    text.textContent = message;

    if (currentStatusTimer) {
        window.clearTimeout(currentStatusTimer);
        currentStatusTimer = null;
    }

    if (autoClear) {
        currentStatusTimer = window.setTimeout(() => {
            status.dataset.state = 'idle';
            text.textContent = '';
        }, 4000);
    }
}

function setLoadingStatus(url) {
    const activeUrl = normalizeTargetUrl(url || document.getElementById('targetUrl').value.trim());
    const message = activeUrl ? `Loading ${activeUrl}...` : 'Loading...';
    setStatus(message, 'loading');
}

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

    setLoadingStatus(url);
    iframe.src = proxyUrl;
}

document.getElementById('loadButton').addEventListener('click', loadIframe);

document.getElementById('proxyFrame').addEventListener('load', () => {
    const activeUrl = getUpstreamUrlFromIframe();
    if (!activeUrl) {
        setStatus('Page loaded', 'loaded', { autoClear: true });
        return;
    }

    persistTargetUrl(activeUrl);
    setStatus(`Loaded ${activeUrl}`, 'loaded', { autoClear: true });
});

document.getElementById('targetUrl').addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        loadIframe();
    }
});

window.addEventListener('load', () => {
    document.getElementById('targetUrl').value = getInitialTargetUrl();
    setStatus('Ready', 'idle');
    setTimeout(loadIframe, 500);
});

window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) {
        return;
    }

    if (!event.data || event.data.type !== 'proxit:navigating') {
        return;
    }

    const url = typeof event.data.url === 'string' ? event.data.url : '';
    setLoadingStatus(url);
});
