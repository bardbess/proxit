const test = require('node:test');
const assert = require('node:assert/strict');

const { getProxyTargetUrl, globalizeClassicScriptHelpers } = require('../src/lib/proxy-http');
const { injectProxyClientShim, rewriteHtmlResourceUrls } = require('../src/lib/content-rewriter');
const { rewriteUrlValue, shouldBypassProxyForAbsoluteUrl } = require('../src/lib/url-utils');

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

test('bypasses direct-host proxying for recaptcha resources', () => {
    assert.equal(
        shouldBypassProxyForAbsoluteUrl('https://www.google.com/recaptcha/api2/anchor?ar=1'),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl('https://www.gstatic.com/recaptcha/releases/example/recaptcha__en.js'),
        true
    );
    assert.equal(
        shouldBypassProxyForAbsoluteUrl('https://www.recaptcha.net/recaptcha/api.js'),
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
