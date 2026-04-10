const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildUpstreamHeaders,
    getProxyTargetUrl,
    globalizeClassicScriptHelpers,
    normalizeUpstreamTargetUrl,
    rewriteUpstreamRequestContextUrl,
} = require('../src/lib/proxy-http');
const { injectProxyClientShim, rewriteHtmlResourceUrls } = require('../src/lib/content-rewriter');
const {
    DIRECT_RESOURCE_HOSTS,
    DIRECT_HOST_SUFFIXES,
    DIRECT_PATH_RULES,
    NUMBERED_DIRECT_HOST_SUFFIXES,
    RECAPTCHA_HOSTS,
    rewriteUrlValue,
    shouldBypassProxyForAbsoluteUrl,
} = require('../src/lib/url-utils');

function makeProxyRequest(originalUrl) {
    const parsedUrl = new URL(`http://localhost:3000${originalUrl}`);
    const query = {};

    for (const [key, value] of parsedUrl.searchParams.entries()) {
        if (Object.prototype.hasOwnProperty.call(query, key)) {
            const currentValue = query[key];
            query[key] = Array.isArray(currentValue) ? [...currentValue, value] : [currentValue, value];
            continue;
        }

        query[key] = value;
    }

    return {
        path: parsedUrl.pathname,
        originalUrl,
        query,
        protocol: 'http',
        get(name) {
            const lowerName = String(name).toLowerCase();
            if (lowerName === 'host') {
                return 'localhost:3000';
            }

            return undefined;
        },
    };
}

test('preserves submitted GET params when unwrapping a proxied form action', () => {
    const targetUrl = getProxyTargetUrl(
        makeProxyRequest('/proxy?url=https%3A%2F%2Fexample.com%2Fplay&mode=demo&lang=en')
    );

    assert.equal(targetUrl, 'https://example.com/play?mode=demo&lang=en');
});

test('keeps original action query params alongside submitted GET params', () => {
    const targetUrl = getProxyTargetUrl(
        makeProxyRequest('/proxy?url=https%3A%2F%2Fexample.com%2Fplay%3Fstep%3D1&mode=demo')
    );

    assert.equal(targetUrl, 'https://example.com/play?step=1&mode=demo');
});

test('uses absolute url query origin for non-proxy companion asset requests', () => {
    const targetUrl = getProxyTargetUrl(
        makeProxyRequest('/cm/example/xdi.js?url=https%3A%2F%2Ftranscend-cdn.com%2Fcm%2Fexample%2Fairgap.js')
    );

    assert.equal(
        targetUrl,
        'https://transcend-cdn.com/cm/example/xdi.js?url=https%3A%2F%2Ftranscend-cdn.com%2Fcm%2Fexample%2Fairgap.js'
    );
});

test('strips leaked proxy port from remote http targets', () => {
    const targetUrl = normalizeUpstreamTargetUrl('http://example.com:3000/test.js');

    assert.equal(targetUrl.href, 'http://example.com/test.js');
});

test('remaps self-proxy targets back onto the stored upstream origin', () => {
    const targetUrl = normalizeUpstreamTargetUrl(
        'http://localhost:3000/assets/app.js?v=1',
        'https://catalog.example'
    );

    assert.equal(targetUrl.href, 'https://catalog.example/assets/app.js?v=1');
});

test('forwards upstream cookies while excluding proxy bookkeeping cookies', () => {
    const headers = buildUpstreamHeaders(
        {
            headers: {
                cookie: '__proxit_upstream_origin=https%253A%252F%252Fcatalog.example; session_id=abc123; theme=dark',
            },
        },
        new URL('https://catalog.example/play'),
        Buffer.alloc(0)
    );

    assert.equal(headers.cookie, 'session_id=abc123; theme=dark');
});

test('rewrites proxied referers back to the upstream page url', () => {
    const referer = rewriteUpstreamRequestContextUrl(
        'http://localhost:3000/proxy?url=https%3A%2F%2Fcatalog.example%2Fplay',
        {
            protocol: 'http',
            get(name) {
                return String(name).toLowerCase() === 'host' ? 'localhost:3000' : undefined;
            },
        },
        new URL('https://catalog.example/embed/frame')
    );

    assert.equal(referer, 'https://catalog.example/play');
});

test('does not double-wrap URLs that already point at the local proxy', () => {
    const rewrittenUrl = rewriteUrlValue(
        'http://localhost:3000/proxy?url=https%3A%2F%2Fgames.example%2Fplay%2Fsample-adventure',
        new URL('https://catalog.example/?module=viewgame&id=3356'),
        'http://localhost:3000'
    );

    assert.equal(
        rewrittenUrl,
        'http://localhost:3000/proxy?url=https%3A%2F%2Fgames.example%2Fplay%2Fsample-adventure'
    );
});

test('bypasses localhost-style development hosts from proxying', () => {
    assert.equal(
        shouldBypassProxyForAbsoluteUrl('https://collector.localhost/?log=experiment'),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl('https://vnt.localhost/g/collect?v=2'),
        true
    );
});

test('bypasses configured captcha resource paths without bypassing unrelated pages', () => {
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${RECAPTCHA_HOSTS[0]}/recaptcha/api2/anchor?ar=1`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${RECAPTCHA_HOSTS[2]}/recaptcha/releases/example/recaptcha__en.js`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${RECAPTCHA_HOSTS[1]}/recaptcha/api.js`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${RECAPTCHA_HOSTS[0]}/search?q=proxy`),
        false
    );
});

test('bypasses numbered direct-media hosts without bypassing main site pages', () => {
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://c13.${NUMBERED_DIRECT_HOST_SUFFIXES[0]}/assets/app.js`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://c10.${NUMBERED_DIRECT_HOST_SUFFIXES[1]}/media/example.png`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://www.${NUMBERED_DIRECT_HOST_SUFFIXES[0]}/creator-page`),
        false
    );
});

test('bypasses configured direct resource hosts', () => {
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${DIRECT_RESOURCE_HOSTS.at(-1)}/bundle/loader.js`),
        true
    );
});

test('bypasses configured embed bootstrap paths without bypassing unrelated pages', () => {
    const directPathRule = DIRECT_PATH_RULES[0];

    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${directPathRule.hosts[0]}${directPathRule.pathPrefixes[0]}sample-id`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${directPathRule.hosts[0]}${directPathRule.pathPrefixes[1]}js/k=sample`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://${directPathRule.hosts[0]}/watch?v=sample`),
        false
    );
});

test('bypasses configured media host suffixes', () => {
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://img.${DIRECT_HOST_SUFFIXES[1]}/asset.jpg`),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl(`https://rr1---sn-a5mekn7r.${DIRECT_HOST_SUFFIXES[0]}/videoplayback`),
        true
    );
});

test('rewrites unquoted html resource attributes', () => {
    const html = rewriteHtmlResourceUrls(
        '<script src=https://catalog.example/assets/js/app.js></script><link href=https://catalog.example/assets/css/site.css rel=stylesheet>',
        new URL('https://catalog.example/'),
        'http://localhost:3000'
    );

    assert.match(
        html,
        /src="http:\/\/localhost:3000\/proxy\?url=https%3A%2F%2Fcatalog\.example%2Fassets%2Fjs%2Fapp\.js"/
    );
    assert.match(
        html,
        /href="http:\/\/localhost:3000\/proxy\?url=https%3A%2F%2Fcatalog\.example%2Fassets%2Fcss%2Fsite\.css"/
    );
});

test('injects a ready fallback for pages that expect a global ready helper', () => {
    const html = injectProxyClientShim('<html><head></head><body></body></html>', 'http://localhost:3000');

    assert.match(html, /window\.ready = function\(callback\)/);
});

test('injects direct GET form navigation for proxied submissions', () => {
    const html = injectProxyClientShim('<html><head></head><body></body></html>', 'http://localhost:3000');

    assert.match(html, /const buildFormSubmissionUrl = \(form, submitter\) =>/);
    assert.match(html, /if \(method === 'GET'\) \{\s*event\.preventDefault\(\);\s*notifyParentNavigation\(submissionUrl\);\s*window\.location\.href = submissionUrl;/);
});

test('disables upstream service worker registrations in the proxy shim', () => {
    const html = injectProxyClientShim('<html><head></head><body></body></html>', 'http://localhost:3000');

    assert.match(html, /navigator\.serviceWorker && typeof navigator\.serviceWorker\.register === 'function'/);
    assert.match(html, /navigator\.serviceWorker\.register = function\(\) \{/);
    assert.match(html, /return Promise\.resolve\(\{/);
    assert.match(html, /unregister\(\) \{\s*return Promise\.resolve\(true\);/);
});

test('injects a fallback loader for data-iframe play buttons', () => {
    const html = injectProxyClientShim('<html><head></head><body></body></html>', 'http://localhost:3000');

    assert.match(html, /const button = event\.target\.closest && event\.target\.closest\('\.load_iframe_btn'\);/);
    assert.match(html, /const placeholder = button\.closest && button\.closest\('\.iframe_placeholder\[data-iframe\]'\);/);
    assert.match(html, /const iframeMarkup = placeholder\.getAttribute\('data-iframe'\);/);
    assert.match(html, /placeholder\.replaceWith\(iframe\);/);
});

test('injects iframe src and srcdoc rewrite hooks for nested embeds', () => {
    const html = injectProxyClientShim('<html><head></head><body></body></html>', 'http://localhost:3000');

    assert.match(html, /if \(lowerName === 'srcdoc'\) \{\s*return rewriteHtmlString\(String\(value\)\);/);
    assert.match(html, /if \(window\.HTMLIFrameElement\) \{\s*rewriteAttribute\(window\.HTMLIFrameElement\.prototype, 'src'\);\s*rewriteAttribute\(window\.HTMLIFrameElement\.prototype, 'srcdoc'\);/);
});

test('injects html setter and document write rewrite hooks for script-built embeds', () => {
    const html = injectProxyClientShim('<html><head></head><body></body></html>', 'http://localhost:3000');

    assert.doesNotMatch(html, /rewriteHtmlSetter\(Element\.prototype, 'innerHTML'\);/);
    assert.doesNotMatch(html, /rewriteHtmlSetter\(Element\.prototype, 'outerHTML'\);/);
    assert.doesNotMatch(html, /window\.Document\.prototype\.write = function\(\.\.\.args\)/);
    assert.doesNotMatch(html, /window\.Document\.prototype\.writeln = function\(\.\.\.args\)/);
});

test('globalizes classic script helpers for later inline scripts', () => {
    const script = globalizeClassicScriptHelpers(`
const ready = (callback) => callback();
const ajax = { get() {} };
const $ = { id: () => null };
`);

    assert.match(script, /window\.ready =/);
    assert.match(script, /window\.ajax =/);
    assert.match(script, /window\.\$ =/);
});

test('forces jQuery browser globals when a UMD wrapper takes the module path', () => {
    const script = globalizeClassicScriptHelpers(`
return S.noConflict=function(e){return C.$===S&&(C.$=Gt),e&&C.jQuery===S&&(C.jQuery=Vt),S},"undefined"==typeof e&&(C.jQuery=C.$=S),S});
`);

    assert.match(script, /C\.jQuery=C\.\$=S/);
    assert.doesNotMatch(script, /module&&module\.exports&&\(C\.jQuery=C\.\$=module\.exports\)/);
});
