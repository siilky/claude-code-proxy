# Configuration

## server/config.txt

Key=value format. Lines starting with `#` are comments. Inline comments supported.

| Parameter | Default | Description |
|---|---|---|
| `port` | `3000` | Server port |
| `host` | auto | Bind address. Auto-detects Docker (`0.0.0.0`) vs native (`127.0.0.1`) |
| `log_level` | `INFO` | Logging level: `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE` |
| `filter_sampling_params` | `false` | Remove redundant sampling params. Required for Sonnet 4.5 compatibility |
| `auth_modes` | `open` | Comma-separated client auth modes: `open`, `proxy_keys`, `passthrough` |
| `fallback_to_claude_code` | `true` | Fall back to `~/.claude/.credentials.json` if OAuth tokens unavailable |
| `auto_open_browser` | `true` | Auto-open browser for OAuth login on startup (native only) |
| `max_body_size` | `10485760` | Request body limit in bytes (10 MB) |
| `request_timeout` | `30000` | Max time to receive complete request in ms (Slowloris protection) |
| `trust_proxy` | `false` | Trust `X-Forwarded-For`/`X-Real-IP` headers. Enable only behind a reverse proxy |

## Example configurations

Personal use (no auth):
```
auth_modes=open
```

Shared with friends (proxy keys only):
```
auth_modes=proxy_keys
```

Shared + allow direct Anthropic API keys:
```
auth_modes=proxy_keys,passthrough
```

## External files

| File | Location | Purpose |
|---|---|---|
| `tokens.json` | `~/.claude-code-proxy/tokens.json` | OAuth access/refresh tokens (managed by OAuthManager) |
| `keys.json` | `~/.claude-code-proxy/keys.json` | Proxy API keys for client auth (managed manually) |
| `.credentials.json` | `~/.claude/.credentials.json` | Claude Code CLI credentials (fallback, read-only) |
| Presets | `server/presets/*.json` | Request presets (system prompts, suffixes) |
