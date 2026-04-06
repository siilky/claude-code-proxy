const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const ClaudeRequest = require("./ClaudeRequest");
const Logger = require("./Logger");
const OAuthManager = require("./OAuthManager");
const { exec } = require("child_process");

let config = {};
let authModes = new Set(["open"]); // default

// Proxy API keys: { "key-string": "FriendName", ... }
const KEYS_PATH = path.join(process.cwd(), "keys.json");
let proxyKeys = {};
let keysFileMtime = 0;

function loadProxyKeys() {
  if (!authModes.has("proxy_keys")) return;

  try {
    const stat = fs.statSync(KEYS_PATH);
    if (stat.mtimeMs === keysFileMtime) return;
    keysFileMtime = stat.mtimeMs;
    const data = fs.readFileSync(KEYS_PATH, "utf8");
    proxyKeys = JSON.parse(data);
    Logger.info(
      `Loaded ${Object.keys(proxyKeys).length} proxy key(s) from keys.json`,
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      Logger.warn(`auth_modes includes proxy_keys but ${KEYS_PATH} not found`);
    } else {
      Logger.warn(`Failed to load proxy keys: ${error.message}`);
    }
  }
}

// PKCE state storage with automatic expiration (10 minutes)
const pkceStates = new Map();
const PKCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PKCE_STATES = 10;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_REQUEST_TIMEOUT = 30_000; // 30s to receive complete request
const HEADERS_TIMEOUT = 10_000; // 10s to receive headers
const IDLE_SOCKET_TIMEOUT = 300_000; // 5min inactivity kills socket

function cleanupExpiredPKCE() {
  const now = Date.now();
  for (const [state, data] of pkceStates.entries()) {
    if (now - data.created_at > PKCE_EXPIRY_MS) {
      pkceStates.delete(state);
    }
  }
}

// Cleanup expired PKCE states every minute
setInterval(cleanupExpiredPKCE, 60000);

function loadConfig() {
  try {
    const configPath = path.join(__dirname, "config.txt");
    const configFile = fs.readFileSync(configPath, "utf8");

    configFile.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=").trim();
        const commentIndex = value.indexOf("#");
        config[key.trim()] =
          commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });

    Logger.init(config);

    Logger.info("Config loaded from config.txt");
  } catch (error) {
    Logger.error("Failed to load config:", error.message);
    process.exit(1);
  }
}

function parseBody(req) {
  const maxBytes = Number(config.max_body_size) || DEFAULT_MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let body = "";
    let received = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received > maxBytes) {
        rejected = true;
        req.destroy();
        const err = new Error(
          `Request body too large (limit ${maxBytes} bytes)`,
        );
        err.statusCode = 413;
        reject(err);
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const err = new Error(`Invalid JSON: ${error.message}`);
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", (err) => {
      if (rejected) return;
      reject(err);
    });
  });
}

function getClientIP(req) {
  if (config.trust_proxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return forwarded.split(",")[0].trim();
    if (req.headers["x-real-ip"]) return req.headers["x-real-ip"];
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const HTML_404 = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>404</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5;color:#333}div{text-align:center}h1{font-size:4em;margin:0;color:#999}p{margin:.5em 0;color:#666}</style>
</head><body><div><h1>404</h1><p>Not found</p></div></body></html>`;

const STATIC_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
};

function serveStaticFile(res, filePath, contentType) {
  const staticPath = path.join(__dirname, "static", filePath);
  fs.readFile(staticPath, "utf8", (err, data) => {
    if (err) {
      Logger.warn(`Static file not found: ${filePath}`);
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(HTML_404);
      return;
    }
    const headers = { "Content-Type": contentType };
    if (contentType === "text/html") {
      Object.assign(headers, STATIC_SECURITY_HEADERS);
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function openBrowser(url) {
  let command;
  if (process.platform === "darwin") {
    command = `open "${url}"`;
  } else if (process.platform === "win32") {
    // start is a shell built-in; first quoted arg is window title, so use empty title
    command = `cmd /c start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      Logger.debug(`Failed to open browser: ${error.message}`);
    }
  });
}

function authenticateClient(req) {
  const apiKey = req.headers["x-api-key"];

  // Passthrough: direct Anthropic API key
  if (apiKey && apiKey.includes("sk-ant")) {
    if (!authModes.has("passthrough")) {
      Logger.warn("Passthrough auth attempted but mode not enabled");
      return null;
    }
    return { token: apiKey, clientName: "passthrough" };
  }

  let keyName = undefined;

  // Proxy key
  if (apiKey) {
    loadProxyKeys();
    keyName = proxyKeys[apiKey];
  }

  // no key || !proxyKeys[apiKey] -> open
  if (!keyName) {
    if (!authModes.has("open")) {
      Logger.warn("No/invalid API key provided");
      return null;
    }

    return { token: null, clientName: "open" };
  }

  return { token: null, clientName: keyName };
}

function isRunningInDocker() {
  // Check for /.dockerenv file (Docker creates this)
  if (fs.existsSync("/.dockerenv")) return true;

  // Check /proc/self/cgroup for docker/containerd (Linux)
  try {
    const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
    return cgroup.includes("docker") || cgroup.includes("containerd");
  } catch (err) {
    return false;
  }
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  Logger.info(`${req.method} ${pathname}`);

  res.on('finish', () => {
    const tag = req.clientName ? ` [${req.clientName}]` : '';
    Logger.info(`[${clientIP}] ${req.method} ${pathname}${tag} -> ${res.statusCode}`);
  });

  try {
    return await _handleRequest(req, res, clientIP, parsedUrl, pathname);
  } catch (error) {
    Logger.error(
      `Unhandled error in ${req.method} ${pathname}:`,
      error.message,
    );
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

async function _handleRequest(req, res, clientIP, parsedUrl, pathname) {
  // Auth routes — localhost only
  if (pathname.startsWith("/auth/")) {
    if (!isLocalRequest(req)) {
      Logger.warn(
        `Auth endpoint ${pathname} accessed from non-local IP ${clientIP}, rejected`,
      );
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(HTML_404);
      return;
    }
  }

  // Static files
  if (req.method === "GET" && pathname.startsWith("/static/")) {
    const file = path.basename(pathname);
    const ext = path.extname(file);
    const types = { ".js": "application/javascript", ".css": "text/css" };
    const ct = types[ext];
    if (ct && /^[\w.-]+$/.test(file)) {
      serveStaticFile(res, file, ct);
      return;
    }
  }

  // OAuth Routes
  if (pathname === "/auth/login" && req.method === "GET") {
    serveStaticFile(res, "login.html", "text/html");
    return;
  }

  if (pathname === "/auth/get-url" && req.method === "GET") {
    try {
      if (pkceStates.size >= MAX_PKCE_STATES) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Too many pending authorization requests" }),
        );
        return;
      }
      const pkce = OAuthManager.generatePKCE();
      pkceStates.set(pkce.state, {
        code_verifier: pkce.code_verifier,
        created_at: Date.now(),
      });

      const authUrl = OAuthManager.buildAuthorizationURL(pkce);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: authUrl, state: pkce.state }));
      Logger.info("Generated OAuth authorization URL");
    } catch (error) {
      Logger.error("OAuth get-url error:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate OAuth URL" }));
    }
    return;
  }

  if (pathname === "/auth/callback" && req.method === "GET") {
    try {
      const query = parsedUrl.query;
      let code = query.code;
      let state = query.state;

      // Handle manual code entry format: "code#state"
      if (query.manual_code) {
        const parts = query.manual_code.split("#");
        if (parts.length !== 2) {
          throw new Error("Invalid code format. Expected: code#state");
        }
        code = parts[0];
        state = parts[1];
      }

      if (!code || !state) {
        throw new Error("Missing authorization code or state");
      }

      const pkceData = pkceStates.get(state);
      if (!pkceData) {
        throw new Error(
          "Invalid or expired state parameter. Please start the authorization process again.",
        );
      }

      pkceStates.delete(state);

      const tokens = await OAuthManager.exchangeCodeForTokens(
        code,
        pkceData.code_verifier,
        state,
      );

      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      };
      OAuthManager.saveTokens(tokenData);

      serveStaticFile(res, "callback.html", "text/html");
      Logger.info("OAuth authentication successful");
    } catch (error) {
      Logger.error("OAuth callback error:", error.message);
      res.writeHead(302, {
        Location: "/auth/login?error=" + encodeURIComponent(error.message),
      });
      res.end();
    }
    return;
  }

  if (pathname === "/auth/status" && req.method === "GET") {
    try {
      const isAuthenticated = OAuthManager.isAuthenticated();
      const expiration = OAuthManager.getTokenExpiration();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          authenticated: isAuthenticated,
          expires_at: expiration ? expiration.toISOString() : null,
        }),
      );
    } catch (error) {
      Logger.error("Auth status error:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Failed to check authentication status" }),
      );
    }
    return;
  }

  if (pathname === "/auth/logout" && req.method === "POST") {
    try {
      OAuthManager.logout();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ success: true, message: "Logged out successfully" }),
      );
      Logger.info("User logged out");
    } catch (error) {
      Logger.error("Logout error:", error.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to logout" }));
    }
    return;
  }

  if (pathname === "/" && req.method === "GET") {
    serveStaticFile(res, "index.html", "text/html");
    return;
  }

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        server: "claude-code-proxy",
        timestamp: Date.now(),
      }),
    );
    return;
  }

  if (
    req.method === "POST" &&
    (pathname === "/v1/messages" || pathname.match(/^\/v1\/\w+\/messages$/))
  ) {
    try {
      const auth = authenticateClient(req);
      if (!auth) {
        Logger.warn(
          `Auth rejected for ${req.method} ${pathname} from ${clientIP}`,
        );
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid proxy API key" }));
        return;
      }
      req.clientName = auth.clientName;

      Logger.headers("Incoming request headers", req.headers);
      const body = await parseBody(req);

      if (!body.model || typeof body.model !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Missing or invalid "model" field' }));
        return;
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: 'Missing or invalid "messages" field' }),
        );
        return;
      }

      Logger.body("Incoming request body", body);

      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) {
        presetName = presetMatch[1];
        Logger.debug(`Detected preset: ${presetName}`);
      }

      await new ClaudeRequest(auth.token, auth.clientName).handleResponse(res, body, presetName);
    } catch (error) {
      const status = error.statusCode || 500;
      Logger.error(`Request error (${status}):`, error.message);
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    }
    return;
  }

  Logger.debug(`404 Not Found: ${req.method} ${pathname}`);
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end(HTML_404);
}

function startServer() {
  loadConfig();

  if (config.auth_modes) {
    authModes = new Set(config.auth_modes.split(",").map((s) => s.trim()));
    const valid = ["open", "proxy_keys", "passthrough"];
    for (const mode of authModes) {
      if (!valid.includes(mode)) {
        Logger.error(`Unknown auth_mode: ${mode}. Valid: ${valid.join(", ")}`);
        process.exit(1);
      }
    }
  }
  Logger.info(`Auth modes: ${[...authModes].join(", ")}`);

  loadProxyKeys();

  const server = http.createServer(handleRequest);
  const requestTimeout =
    Number(config.request_timeout) || DEFAULT_REQUEST_TIMEOUT;
  server.requestTimeout = requestTimeout;
  server.headersTimeout = Math.min(HEADERS_TIMEOUT, requestTimeout);
  server.timeout = IDLE_SOCKET_TIMEOUT;

  const port = parseInt(config.port) || 3000;

  // Smart host binding: auto-detect Docker or use config
  const host = config.host || (isRunningInDocker() ? "0.0.0.0" : "127.0.0.1");

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      Logger.error(`Port ${port} is already in use`);
    } else if (error.code === "EACCES") {
      Logger.error(`Permission denied to bind to ${host}:${port}`);
    } else {
      Logger.error(`Server error: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    Logger.info(`claude-code-proxy server listening on ${host}:${port}`);
    Logger.info(
      `Timeouts: request=${requestTimeout}ms, headers=${server.headersTimeout}ms, idle=${IDLE_SOCKET_TIMEOUT}ms`,
    );

    // Display authentication status
    const isAuthenticated = OAuthManager.isAuthenticated();
    const expiration = OAuthManager.getTokenExpiration();

    Logger.info("");
    Logger.info("Authentication Status:");
    if (isAuthenticated && expiration) {
      Logger.info(`  ✓ Authenticated until ${expiration.toLocaleString()}`);
    } else {
      Logger.info("  ✗ Not authenticated");
      const authUrl = `http://localhost:${port}/auth/login`;
      Logger.info(`  → Visit ${authUrl} to authenticate`);

      // Auto-open browser if configured (only works when running natively)
      const autoOpenBrowser = config.auto_open_browser !== "false";
      if (!isAuthenticated && autoOpenBrowser && !isRunningInDocker()) {
        Logger.info("  → Opening browser for authentication...");
        setTimeout(() => openBrowser(authUrl), 1000);
      }
    }
    Logger.info("");
  });

  process.on("SIGTERM", () => {
    Logger.info("Shutting down...");
    server.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    Logger.info("Shutting down...");
    server.close(() => process.exit(0));
  });

  process.on("uncaughtException", (error) => {
    Logger.error("Uncaught exception:", error.message);
    Logger.debug("Stack:", error.stack);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    Logger.error("Unhandled promise rejection:", message);
    if (reason instanceof Error) {
      Logger.debug("Stack:", reason.stack);
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };
