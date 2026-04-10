const { DIRECT_RESOURCE_HOSTS } = require('../config');
const {
    rewriteLocationHeader,
    rewriteSrcsetValue,
    rewriteUrlValue,
} = require('./url-utils');

function rewriteHtmlResourceUrls(html, baseUrl, proxyOrigin = '') {
    const resourceAttributesByTag = {
        a: ['href'],
        area: ['href'],
        audio: ['src'],
        form: ['action'],
        iframe: ['src'],
        img: ['src', 'srcset'],
        input: ['src'],
        link: ['href'],
        script: ['src'],
        source: ['src', 'srcset'],
        track: ['src'],
        video: ['src', 'poster'],
    };

    const preservedBlocks = [];
    const protectedHtml = html.replace(
        /<(script|style|textarea|noscript)\b[\s\S]*?<\/\1>/gi,
        (block) => {
            const token = `__PROXIT_PRESERVED_BLOCK_${preservedBlocks.length}__`;
            preservedBlocks.push(block);
            return token;
        }
    );

    const rewrittenHtml = protectedHtml.replace(/<[^>]+>/g, (tag) => {
        if (/^<\//.test(tag)) {
            return tag;
        }

        const tagNameMatch = tag.match(/^<\s*([a-z0-9-]+)/i);
        const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : '';
        const resourceAttributes = resourceAttributesByTag[tagName] || [];
        let rewrittenTag = tag;

        for (const attribute of resourceAttributes) {
            rewrittenTag = rewrittenTag.replace(
                new RegExp(`\\b(${attribute})=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi'),
                (match, attr, doubleQuotedPath, singleQuotedPath, unquotedPath) => {
                    const path = doubleQuotedPath ?? singleQuotedPath ?? unquotedPath ?? '';
                    const rewrittenValue = attr.toLowerCase() === 'srcset'
                        ? rewriteSrcsetValue(path, baseUrl, proxyOrigin)
                        : rewriteUrlValue(path, baseUrl, proxyOrigin);
                    return `${attr}="${rewrittenValue}"`;
                }
            );
        }

        rewrittenTag = rewrittenTag.replace(/\starget=["']_blank["']/gi, ' target="_self"');
        rewrittenTag = rewrittenTag.replace(/\sintegrity=["'][^"']*["']/gi, '');
        rewrittenTag = rewrittenTag.replace(/\scrossorigin=["'][^"']*["']/gi, '');

        return rewrittenTag;
    });

    const restoredHtml = rewrittenHtml.replace(
        /__PROXIT_PRESERVED_BLOCK_(\d+)__/g,
        (match, index) => preservedBlocks[Number(index)] || match
    );

    return restoredHtml.replace(/<script\b[^>]*>/gi, (tag) => {
        return tag.replace(
            /\b(src)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
            (match, attr, doubleQuotedPath, singleQuotedPath, unquotedPath) => {
                const path = doubleQuotedPath ?? singleQuotedPath ?? unquotedPath ?? '';
                const rewrittenValue = rewriteUrlValue(path, baseUrl, proxyOrigin);
                return `${attr}="${rewrittenValue}"`;
            }
        );
    });
}

function injectProxyBaseTag(html, baseUrl) {
    const baseTag = `<base data-proxit-base href="${baseUrl.href}">`;

    if (/<base\b[^>]*data-proxit-base/i.test(html)) {
        return html.replace(/<base\b[^>]*data-proxit-base[^>]*>/i, baseTag);
    }

    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    }

    if (/<html[^>]*>/i.test(html)) {
        return html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
    }

    return `${baseTag}${html}`;
}

function injectProxyClientShim(html, proxyOrigin) {
    const shim = `
<script>
(() => {
    if (window.__proxitShimInstalled) {
        return;
    }
    window.__proxitShimInstalled = true;

    const proxyOrigin = ${JSON.stringify(proxyOrigin)};
    const directResourceHosts = ${JSON.stringify(DIRECT_RESOURCE_HOSTS)};
    if (typeof window.ready !== 'function') {
        window.ready = function(callback) {
            if (typeof callback !== 'function') {
                return;
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => callback.call(document), { once: true });
                return;
            }

            callback.call(document);
        };
    }

    const upstreamBase = (() => {
        const baseElement = document.querySelector('base[data-proxit-base]');
        return baseElement ? baseElement.href : document.baseURI;
    })();
    const notifyParentNavigation = (url) => {
        if (!window.parent || window.parent === window) {
            return;
        }

        try {
            window.parent.postMessage({
                type: 'proxit:navigating',
                url: String(url || '')
            }, proxyOrigin || '*');
        } catch {
            // Ignore cross-window messaging failures.
        }
    };
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
            return new URL(value, upstreamBase).href;
        } catch {
            return value;
        }
    };

    const shouldBypassProxyForAbsoluteUrl = (absoluteUrl) => {
        try {
            const url = new URL(absoluteUrl);
            const hostname = url.hostname.toLowerCase();
            return directResourceHosts.some((directHost) => hostname === directHost || hostname.endsWith('.' + directHost));
        } catch {
            return false;
        }
    };

    const toProxyUrl = (value) => {
        if (shouldBypass(value)) {
            return value;
        }

        const absoluteUrl = toAbsoluteUrl(value);
        if (shouldBypassProxyForAbsoluteUrl(absoluteUrl)) {
            return absoluteUrl;
        }
        return proxyOrigin + '/proxy?url=' + encodeURIComponent(absoluteUrl);
    };

    const shouldProxyRequest = (value) => {
        if (!value || shouldBypass(value)) {
            return false;
        }

        const absoluteUrl = toAbsoluteUrl(value);
        if (shouldBypassProxyForAbsoluteUrl(absoluteUrl)) {
            return false;
        }

        if (!/^https?:/i.test(absoluteUrl)) {
            return false;
        }

        if (absoluteUrl.startsWith(proxyOrigin + '/')) {
            return false;
        }

        return true;
    };

    const rewriteSrcsetValue = (value) => {
        return String(value)
            .split(',')
            .map((candidate) => {
                const trimmed = candidate.trim();
                if (!trimmed) {
                    return candidate;
                }

                const parts = trimmed.split(/\\s+/);
                const rewrittenUrl = shouldProxyRequest(parts[0]) ? toProxyUrl(parts[0]) : parts[0];
                return [rewrittenUrl, ...parts.slice(1)].join(' ');
            })
            .join(', ');
    };

    const rewriteMarkupValue = (attributeName, value) => {
        if (value == null) {
            return value;
        }

        const lowerName = String(attributeName).toLowerCase();
        if (lowerName === 'target' && String(value).toLowerCase() === '_blank') {
            return '_self';
        }

        if (lowerName === 'srcset') {
            return rewriteSrcsetValue(value);
        }

        if (['src', 'href', 'action', 'poster'].includes(lowerName) && shouldProxyRequest(String(value))) {
            return toProxyUrl(String(value));
        }

        return value;
    };

    const rewriteMarkupTree = (root) => {
        if (!root || typeof root.querySelectorAll !== 'function') {
            return root;
        }

        const elements = [];
        if (root.nodeType === Node.ELEMENT_NODE) {
            elements.push(root);
        }
        elements.push(...root.querySelectorAll('*'));

        for (const element of elements) {
            for (const attributeName of ['src', 'href', 'action', 'poster', 'srcset']) {
                if (element.hasAttribute && element.hasAttribute(attributeName)) {
                    const currentValue = element.getAttribute(attributeName);
                    const nextValue = rewriteMarkupValue(attributeName, currentValue);
                    if (nextValue !== currentValue) {
                        element.setAttribute(attributeName, nextValue);
                    }
                }
            }

            if (element.hasAttribute && element.hasAttribute('target') && element.getAttribute('target').toLowerCase() === '_blank') {
                element.setAttribute('target', '_self');
            }

            if (element.removeAttribute) {
                element.removeAttribute('integrity');
                element.removeAttribute('crossorigin');
            }
        }

        return root;
    };

    const rewriteHtmlString = (markup) => {
        if (typeof markup !== 'string' || !markup.includes('<')) {
            return markup;
        }

        const template = document.createElement('template');
        const templateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (!templateDescriptor || !templateDescriptor.set || !templateDescriptor.get) {
            return markup;
        }

        templateDescriptor.set.call(template, markup);
        rewriteMarkupTree(template.content);
        return templateDescriptor.get.call(template);
    };

    window.open = function(url) {
        if (url) {
            const destinationUrl = toProxyUrl(url);
            notifyParentNavigation(destinationUrl);
            window.location.href = destinationUrl;
        }
        return window;
    };

    document.addEventListener('click', (event) => {
        const link = event.target.closest && event.target.closest('a[href]');
        if (!link) {
            return;
        }

        const href = link.getAttribute('href');
        if (!href || shouldBypass(href)) {
            return;
        }

        notifyParentNavigation(link.href || toProxyUrl(href));
    }, true);

    document.addEventListener('click', (event) => {
        const link = event.target.closest && event.target.closest('a[target="_blank"]');
        if (!link) {
            return;
        }

        event.preventDefault();
        notifyParentNavigation(link.href);
        window.location.href = link.href;
    }, true);

    const getFormSubmissionTarget = (form) => {
        const rawAction = form.getAttribute('action');
        if (!rawAction) {
            return upstreamBase;
        }

        if (shouldBypass(rawAction)) {
            return rawAction;
        }

        return toAbsoluteUrl(rawAction);
    };

    const buildFormSubmissionUrl = (form, submitter) => {
        const submissionTarget = getFormSubmissionTarget(form);
        if (!submissionTarget || shouldBypass(submissionTarget)) {
            return submissionTarget;
        }

        const method = (form.getAttribute('method') || 'GET').toUpperCase();
        if (method !== 'GET') {
            return toProxyUrl(submissionTarget);
        }

        const actionUrl = new URL(submissionTarget, window.location.href);
        const formData = typeof FormData === 'function'
            ? new FormData(form, submitter)
            : null;

        if (formData) {
            for (const [key, value] of formData.entries()) {
                if (typeof value === 'string') {
                    actionUrl.searchParams.append(key, value);
                }
            }
        }

        return toProxyUrl(actionUrl.href);
    };

    document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
            return;
        }

        const submissionTarget = getFormSubmissionTarget(form);
        if (!submissionTarget || shouldBypass(submissionTarget)) {
            return;
        }

        const submissionUrl = buildFormSubmissionUrl(form, event.submitter);
        form.setAttribute('action', submissionUrl);
        const target = form.getAttribute('target');
        if (target && target.toLowerCase() === '_blank') {
            form.setAttribute('target', '_self');
        }

        const method = (form.getAttribute('method') || 'GET').toUpperCase();
        if (method === 'GET') {
            event.preventDefault();
            notifyParentNavigation(submissionUrl);
            window.location.href = submissionUrl;
        }
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
                const nextValue = rewriteMarkupValue(attributeName, value);
                descriptor.set.call(this, nextValue);
            }
        });
    };

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        const lowerName = String(name).toLowerCase();
        const nextValue = rewriteMarkupValue(lowerName, value);

        return originalSetAttribute.call(this, name, nextValue);
    };

    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(position, markup) {
        const rewrittenMarkup = rewriteHtmlString(markup);
        return originalInsertAdjacentHTML.call(this, position, rewrittenMarkup);
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

    const mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    rewriteMarkupTree(node);
                });
            }
        }
    });

    mutationObserver.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
    });

    const installJQueryHooks = () => {
        const $ = window.jQuery;
        if (!$ || $.__proxitHooksInstalled) {
            return;
        }

        $.__proxitHooksInstalled = true;

        if (typeof $.ajaxPrefilter === 'function') {
            $.ajaxPrefilter((options) => {
                if (options && typeof options.url === 'string' && shouldProxyRequest(options.url)) {
                    options.url = toProxyUrl(options.url);
                }
            });
        }

        for (const methodName of ['html', 'append', 'prepend', 'before', 'after', 'replaceWith']) {
            const originalMethod = $.fn[methodName];
            if (typeof originalMethod !== 'function') {
                continue;
            }

            $.fn[methodName] = function(...args) {
                const rewrittenArgs = args.map((arg) => typeof arg === 'string' ? rewriteHtmlString(arg) : arg);
                return originalMethod.apply(this, rewrittenArgs);
            };
        }

        for (const methodName of ['attr', 'prop']) {
            const originalMethod = $.fn[methodName];
            if (typeof originalMethod !== 'function') {
                continue;
            }

            $.fn[methodName] = function(name, value) {
                if (arguments.length >= 2 && typeof name === 'string') {
                    const nextValue = rewriteMarkupValue(name, value);
                    return originalMethod.call(this, name, nextValue);
                }
                return originalMethod.apply(this, arguments);
            };
        }
    };

    installJQueryHooks();
    let jqueryHookAttempts = 0;
    const jqueryHookTimer = window.setInterval(() => {
        installJQueryHooks();
        jqueryHookAttempts += 1;
        if (window.jQuery || jqueryHookAttempts >= 200) {
            window.clearInterval(jqueryHookTimer);
        }
    }, 50);

})();
</script>`;

    if (/<base\b[^>]*data-proxit-base[^>]*>/i.test(html)) {
        return html.replace(/(<base\b[^>]*data-proxit-base[^>]*>)/i, `$1${shim}`);
    }

    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>${shim}`);
    }

    if (/<body[^>]*>/i.test(html)) {
        return html.replace(/<body([^>]*)>/i, `<body$1>${shim}`);
    }

    return `${shim}${html}`;
}

function rewriteCssResourceUrls(css, baseUrl, proxyOrigin = '') {
    const rewrittenUrls = css.replace(
        /url\((['"]?)([^)'"]+)\1\)/gi,
        (match, quote, path) => `url(${quote}${rewriteUrlValue(path.trim(), baseUrl, proxyOrigin)}${quote})`
    );

    return rewrittenUrls.replace(
        /@import\s+(?:url\()?(['"])([^'"]+)\1\)?/gi,
        (match, quote, path) => match.replace(path, rewriteUrlValue(path.trim(), baseUrl, proxyOrigin))
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

module.exports = {
    rewriteHtmlResourceUrls,
    injectProxyBaseTag,
    injectProxyClientShim,
    rewriteCssResourceUrls,
    rewriteSetCookieHeader,
    rewriteLocationHeader,
};
