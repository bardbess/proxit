# Proxit

Proxit is a small Express-based server-side proxy for loading remote pages inside an iframe. It fetches upstream content on the server, rewrites resource URLs, and strips common frame-blocking headers so the page can render through the local proxy.

## Features

- Proxies remote `http` and `https` pages through `/proxy`
- Rewrites HTML and CSS resource URLs to keep navigation inside the proxy
- Injects a client shim so dynamic requests continue to route through the proxy
- Supports optional upstream host override / DoH resolution behavior
- Includes a simple local UI for entering a target URL

## Requirements

- Node.js
- npm

## Getting started

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Environment variables

- `PORT`: Local server port. Defaults to `3000`.
- `DEBUG_PROXY`: Set to `1` to print proxy debug logs.
- `UPSTREAM_HOST_OVERRIDES`: Comma-separated hostnames to resolve outside the local hosts file. Use `*` to bypass for all upstream hosts.
- `UPSTREAM_DOH_URL`: Optional DNS-over-HTTPS resolver URL. When `UPSTREAM_HOST_OVERRIDES=*`, the default is Google DoH at `https://dns.google/resolve`.

## Project structure

```text
server.js                  # Thin entrypoint
src/app.js                 # Express app setup and route wiring
src/config.js              # Shared environment/config values
src/lib/proxy-http.js      # Proxy request flow and upstream response handling
src/lib/content-rewriter.js# HTML/CSS/header rewriting helpers
src/lib/url-utils.js       # Proxy URL and rewrite helpers
src/lib/upstream-resolver.js # Upstream DNS / DoH resolution helpers
src/lib/logging.js         # Debug logging helper
src/templates/proxit.html  # Main UI template
public/app.css             # UI styles
public/app.js              # UI behavior
```

## Notes

- This project is intended for development and experimentation, not hardened production use.
- Some upstream sites may still break because of CSP, runtime assumptions, authentication flows, or aggressive anti-bot behavior.
