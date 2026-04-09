const express = require('express');

const { PORT } = require('./config');
const { getProxyTargetUrl, proxyRequest } = require('./lib/proxy-http');
const { getHomePageHtml } = require('./routes/home-page');

function createApp() {
    const app = express();

    app.use((req, res, next) => {
        res.setHeader('X-Frame-Options', 'ALLOWALL');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self' *;");
        next();
    });

    app.get('/', (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(getHomePageHtml());
    });

    app.all('/proxy', async (req, res) => {
        const targetUrl = getProxyTargetUrl(req);

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

    return app;
}

function startServer() {
    const app = createApp();

    return app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Try: http://localhost:${PORT}/proxy?url=https://httpbin.org/html`);
    });
}

module.exports = {
    createApp,
    startServer,
};
