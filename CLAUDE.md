# CLAUDE.md

Proxy server for Claude API using Claude.ai subscription credentials (OAuth 2.0 PKCE). Anthropic Messages API schema on input, forwarded as-is.

## Commands

```bash
npm start              # Start server (node server/server.js)
npm test               # Run all Jest tests
npx jest server/<file> # Single test file
```

## Modules

- **server.js** - HTTP server, routing, client auth (`authenticateClient`), OAuth pages, PKCE state
- **ClaudeRequest.js** - Request forwarding to Anthropic, token resolution, system prompt injection, presets, streaming
- **OAuthManager.js** - OAuth 2.0 PKCE flow, token storage (`~/.claude-code-proxy/tokens.json`)
- **Logger.js** - Level-based logging with stream debugging

## Key design decisions

- Client auth (`auth_modes`: `open`/`proxy_keys`/`passthrough`) is in server.js, before body parsing. ClaudeRequest only knows passthrough vs OAuth.
- Proxy keys (`keys.json`) hot-reload on file change (mtime check). No restart needed.
- Pure Node.js, no runtime dependencies.

## Docs

- [Architecture & request flow](docs/architecture.md)
- [Configuration reference](docs/configuration.md)
- [OAuth specification](docs/oauth-specification.md)
