# Architecture

## Modules

Four modules in `server/`:

- **server.js** - HTTP server, routing, CORS, PKCE state management, client authentication (`authenticateClient`). Serves OAuth login/callback pages and forwards `/v1/messages` requests to Claude API.
- **ClaudeRequest.js** - Core request handler. Receives an optional passthrough token, resolves OAuth tokens, injects the "Claude Code" system prompt, applies presets, strips TTL from cache_control, optionally filters sampling params, forwards HTTPS requests to Anthropic, and streams responses back.
- **OAuthManager.js** - OAuth 2.0 PKCE flow (RFC 7636). Handles authorization URL generation, code exchange, token refresh with race condition protection, and persistent token storage at `~/.claude-code-proxy/tokens.json`. Singleton pattern.
- **Logger.js** - Level-based logging (ERROR/WARN/INFO/DEBUG/TRACE) with stream debugging support.

## Request Flow

1. Client sends POST to `/v1/messages` (or `/v1/{presetName}/messages` for presets)
2. `authenticateClient(req)` checks `x-api-key` against `auth_modes` -- rejects with 403 if unauthorized
3. Body parsed, `ClaudeRequest(passthroughToken)` created
4. Auth token resolved: passthrough token used directly, or OAuth token from cache/refresh
5. System prompt "Claude Code" prefix injected; preset applied if path includes preset name
6. TTL stripped from cache_control; sampling params optionally filtered
7. Request forwarded to `api.anthropic.com`; on 401 (non-passthrough) -- token refresh and retry
8. Response streamed back to client (SSE)

## Client Authentication

Configured via `auth_modes` in `config.txt` (comma-separated). Three modes, combinable:

| Mode | `x-api-key` header | Behavior |
|---|---|---|
| `open` | absent | No auth required, use server's OAuth token |
| `proxy_keys` | any non-`sk-ant` string | Validate against `~/.claude-code-proxy/keys.json`, use server's OAuth token |
| `passthrough` | `sk-ant-*` | Forward directly to Anthropic API |

Auth check happens in `server.js:authenticateClient()` **before** body parsing. `ClaudeRequest` only knows about passthrough vs OAuth -- it does not handle client auth.

### Proxy Keys

`keys.json` format (loaded only when `proxy_keys` is active, hot-reloads on file change):
```json
{ "any-key-string": "FriendName", "another-key": "AnotherFriend" }
```

File location: `~/.claude-code-proxy/keys.json` (same directory as OAuth tokens).
Managed manually via text editor. Server detects file changes by mtime -- no restart needed.
