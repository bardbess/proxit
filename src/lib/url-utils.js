const { BYPASS_ALL_UPSTREAM_HOSTS, DIRECT_RESOURCE_HOSTS, UPSTREAM_HOST_OVERRIDES } = require('../config');

function shouldBypassHostsFile(hostname) {
    if (BYPASS_ALL_UPSTREAM_HOSTS) {
        return true;
    }

    return UPSTREAM_HOST_OVERRIDES.has(hostname.toLowerCase());
}

function getProxyOrigin(req) {
    const forwardedProtoHeader = req.get('x-forwarded-proto');
    const protocol = forwardedProtoHeader ? forwardedProtoHeader.split(',')[0].trim() : req.protocol;
    return `${protocol}://${req.get('host')}`;
}

function toProxyUrl(absoluteUrl, proxyOrigin = '') {
    const proxyPath = `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
    return proxyOrigin ? `${proxyOrigin}${proxyPath}` : proxyPath;
}

function unwrapProxyUrl(absoluteUrl, proxyOrigin = '') {
    let currentUrl = absoluteUrl;

    for (let depth = 0; depth < 5; depth += 1) {
        try {
            const parsedUrl = new URL(currentUrl, proxyOrigin || undefined);
            const isLocalProxyPath = parsedUrl.pathname === '/proxy';
            const isMatchingOrigin = !proxyOrigin || parsedUrl.origin === proxyOrigin;

            if (!isLocalProxyPath || !isMatchingOrigin) {
                return parsedUrl.href;
            }

            const nestedUrl = parsedUrl.searchParams.get('url');
            if (!nestedUrl) {
                return parsedUrl.href;
            }

            currentUrl = nestedUrl;
        } catch {
            return currentUrl;
        }
    }

    return currentUrl;
}

function shouldBypassProxyForAbsoluteUrl(absoluteUrl) {
    try {
        const url = new URL(absoluteUrl);
        const hostname = url.hostname.toLowerCase();

        return DIRECT_RESOURCE_HOSTS.some((directHost) => hostname === directHost || hostname.endsWith(`.${directHost}`));
    } catch {
        return false;
    }
}

function isAlreadyProxyUrl(absoluteUrl, proxyOrigin = '') {
    try {
        const url = new URL(absoluteUrl, proxyOrigin || undefined);
        if (url.pathname !== '/proxy') {
            return false;
        }

        if (!proxyOrigin) {
            return true;
        }

        return url.origin === proxyOrigin;
    } catch {
        return false;
    }
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

function rewriteUrlValue(path, baseUrl, proxyOrigin = '') {
    if (shouldLeaveUrlAlone(path)) {
        return path;
    }

    try {
        const absolute = new URL(path, baseUrl).href;
        if (isAlreadyProxyUrl(absolute, proxyOrigin)) {
            return absolute;
        }
        if (shouldBypassProxyForAbsoluteUrl(absolute)) {
            return absolute;
        }
        return toProxyUrl(absolute, proxyOrigin);
    } catch {
        return path;
    }
}

function rewriteSrcsetValue(value, baseUrl, proxyOrigin = '') {
    return value
        .split(',')
        .map((candidate) => {
            const trimmed = candidate.trim();
            if (!trimmed) {
                return candidate;
            }

            const parts = trimmed.split(/\s+/);
            const rewrittenUrl = rewriteUrlValue(parts[0], baseUrl, proxyOrigin);
            return [rewrittenUrl, ...parts.slice(1)].join(' ');
        })
        .join(', ');
}

function rewriteLocationHeader(value, baseUrl, proxyOrigin = '') {
    if (!value) {
        return value;
    }

    try {
        return toProxyUrl(new URL(value, baseUrl).href, proxyOrigin);
    } catch {
        return value;
    }
}

module.exports = {
    shouldBypassHostsFile,
    getProxyOrigin,
    toProxyUrl,
    unwrapProxyUrl,
    isAlreadyProxyUrl,
    shouldBypassProxyForAbsoluteUrl,
    shouldLeaveUrlAlone,
    rewriteUrlValue,
    rewriteSrcsetValue,
    rewriteLocationHeader,
};
