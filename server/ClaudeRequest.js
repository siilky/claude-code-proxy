const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Transform } = require('stream');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');

const STRIP_TTL = false;
const TOKEN_REFRESH_METHOD = 'OAUTH'; // 'OAUTH' or 'CLAUDE_CODE_CLI'

// Load configuration
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = {};

    configData.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const commentIndex = trimmed.indexOf('#');
      const cleanLine = commentIndex !== -1 ? trimmed.substring(0, commentIndex).trim() : trimmed;

      const [key, value] = cleanLine.split('=').map(s => s.trim());
      if (key && value !== undefined) {
        config[key] = value === 'true' ? true : value === 'false' ? false : value;
      }
    });

    return config;
  } catch (error) {
    Logger.warn(`Failed to load config: ${error.message}`);
    return {};
  }
};

const CONFIG = loadConfig();
const FILTER_SAMPLING_PARAMS = CONFIG.filter_sampling_params === true; // Default to false
const INJECT_CACHE_BREAKPOINTS = CONFIG.inject_cache_breakpoints !== false; // Default to true
const FALLBACK_TO_CLAUDE_CODE = CONFIG.fallback_to_claude_code !== false; // Default to true

class ClaudeRequest {
  static presetCache = new Map();
  static refreshPromise = null;

  constructor(passthroughToken = null, clientName = null) {
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,files-api-2025-04-14,oauth-2025-04-20,interleaved-thinking-2025-05-14';
    this.passthroughToken = passthroughToken;
    this.logTag = clientName ? `[${clientName}] ` : '';
    this.refreshToken = TOKEN_REFRESH_METHOD === 'OAUTH' ? this.refreshTokenWithOauth : this.refreshTokenWithClaudeCodeCli;
  }

  stripTtlFromCacheControl(body) {
    if (!STRIP_TTL) return body;
    if (!body || typeof body !== 'object') return body;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;

      contentArray.forEach(item => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl;
            Logger.debug('Removed ttl from cache_control');
          }
        }
      });
    };

    if (Array.isArray(body.system)) {
      processContentArray(body.system);
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }

    return body;
  }

  filterSamplingParams(body) {
    if (!FILTER_SAMPLING_PARAMS) return body;
    if (!body || typeof body !== 'object') return body;

    const hasTemperature = body.temperature !== undefined;
    const hasTopP = body.top_p !== undefined;

    // If both are present, we need to keep only one
    if (hasTemperature && hasTopP) {
      const tempIsDefault = body.temperature === 1.0;
      const topPIsDefault = body.top_p === 1.0;

      // If both are default, remove top_p (arbitrary choice)
      if (tempIsDefault && topPIsDefault) {
        delete body.top_p;
        Logger.debug('Removed top_p=1.0 from request (both at default, keeping temperature)');
      }
      // If only top_p is default, remove it
      else if (topPIsDefault) {
        delete body.top_p;
        Logger.debug(`Removed top_p=1.0 from request (keeping temperature=${body.temperature})`);
      }
      // If only temperature is default, remove it and keep top_p
      else if (tempIsDefault) {
        delete body.temperature;
        Logger.debug(`Removed temperature=1.0 from request (keeping top_p=${body.top_p})`);
      }
      // If both are non-default, prefer temperature over top_p
      else {
        const topPValue = body.top_p;
        delete body.top_p;
        Logger.debug(`Removed top_p=${topPValue} from request (preferring temperature=${body.temperature})`);
      }
    }
    // If only top_p is present and it's default, remove it
    else if (hasTopP && body.top_p === 1.0) {
      delete body.top_p;
      Logger.debug('Removed top_p=1.0 from request (default value, no temperature specified)');
    }
    // If only temperature is present and it's default, remove it
    else if (hasTemperature && body.temperature === 1.0) {
      delete body.temperature;
      Logger.debug('Removed temperature=1.0 from request (default value, no top_p specified)');
    }

    return body;
  }

  async getAuthToken() {
    if (this.passthroughToken) {
      Logger.debug('Passthrough mode: using client API key');
      return this.passthroughToken.startsWith('Bearer ')
        ? this.passthroughToken
        : `Bearer ${this.passthroughToken}`;
    }

    return await this.loadOrRefreshToken();
  }

  async loadOrRefreshToken() {
    if (OAuthManager.isAuthenticated()) {
      try {
        Logger.debug('Using OAuthManager tokens');
        const token = await OAuthManager.getValidAccessToken();
        return `Bearer ${token}`;
      } catch (error) {
        if (error.code === 'INVALID_GRANT' && FALLBACK_TO_CLAUDE_CODE) {
          Logger.info('OAuth tokens invalidated, trying Claude Code credentials fallback');
          try {
            const token = await this.loadFromClaudeCodeCredentials();
            Logger.info('Successfully fell back to Claude Code credentials');
            return token;
          } catch (fallbackError) {
            Logger.warn(`Claude Code fallback also failed: ${fallbackError.message}`);
          }
        }
        const wrapped = new Error(`Failed to get auth token: ${error.message}`);
        wrapped.code = error.code;
        throw wrapped;
      }
    }

    if (FALLBACK_TO_CLAUDE_CODE) {
      try {
        Logger.debug('Falling back to Claude Code credentials');
        return await this.loadFromClaudeCodeCredentials();
      } catch (error) {
        const wrapped = new Error(`Failed to get auth token: ${error.message}`);
        wrapped.code = error.code;
        throw wrapped;
      }
    }

    throw new Error('Failed to get auth token: No authentication tokens found. Please authenticate first.');
  }

  async loadFromClaudeCodeCredentials() {
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const oauth = credentials.claudeAiOauth;

      if (oauth.expiresAt && Date.now() >= (oauth.expiresAt - 10000)) {
        Logger.info('Claude Code token expired/expiring, refreshing...');
        return await this.refreshToken();
      }

      return `Bearer ${oauth.accessToken}`;
    } catch (error) {
      const wrapped = new Error(`Failed to load Claude Code credentials: ${error.message}`);
      wrapped.code = error.code;
      throw wrapped;
    }
  }

  loadCredentialsFromFile() {
    if (process.platform === 'win32') {
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        Logger.debug(`Loading credentials from ${nativePath}`);
        return fs.readFileSync(nativePath, 'utf8');
      }
      Logger.debug('Native credentials not found, falling back to WSL');
      return execSync('wsl cat ~/.claude/.credentials.json', { encoding: 'utf8', timeout: 10000 });
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      Logger.debug(`Loading credentials from ${credentialsPath}`);
      return fs.readFileSync(credentialsPath, 'utf8');
    }
  }

  writeCredentialsToFile(credentialsJson) {
    if (process.platform === 'win32') {
      // Write to native Windows location if it exists, otherwise use WSL
      const nativePath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (fs.existsSync(nativePath)) {
        fs.writeFileSync(nativePath, credentialsJson, 'utf8');
      } else {
        execSync(`wsl tee ~/.claude/.credentials.json`, { input: credentialsJson, encoding: 'utf8', timeout: 10000 });
      }
    } else {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      fs.writeFileSync(credentialsPath, credentialsJson, 'utf8');
    }
  }


  async refreshTokenWithOauth() {
    // Race condition protection
    if (ClaudeRequest.refreshPromise) {
      return await ClaudeRequest.refreshPromise;
    }
    
    ClaudeRequest.refreshPromise = this._doRefresh();
    try {
      const result = await ClaudeRequest.refreshPromise;
      return result;
    } finally {
      ClaudeRequest.refreshPromise = null;
    }
  }

  async _doRefresh() {
    Logger.info('Refreshing Claude Code OAuth token...');
    try {
      const credentialsData = this.loadCredentialsFromFile();
      const credentials = JSON.parse(credentialsData);
      const refreshToken = credentials.claudeAiOauth?.refreshToken;

      const refreshData = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
      };

      const options = {
        hostname: 'console.anthropic.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'claude-code-proxy/1.0.0'
        }
      };

      const response = await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseData = '';
          res.on('data', chunk => responseData += chunk);
          res.on('end', () => {
            try {
              const response = JSON.parse(responseData);
              if (res.statusCode === 200) {
                resolve(response);
              } else {
                reject(new Error(`OAuth request failed: ${response.error || responseData}`));
              }
            } catch (error) {
              reject(new Error(`Invalid JSON response: ${responseData}`));
            }
          });
        });

        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('OAuth request timeout'));
        });

        req.on('error', reject);
        req.write(JSON.stringify(refreshData));
        req.end();
      });
      
      credentials.claudeAiOauth.accessToken = response.access_token;
      credentials.claudeAiOauth.refreshToken = response.refresh_token;
      credentials.claudeAiOauth.expiresAt = Date.now() + (response.expires_in * 1000);
      
      const credentialsJson = JSON.stringify(credentials);
      this.writeCredentialsToFile(credentialsJson);
      
      Logger.info('Token refreshed successfully');
      return `Bearer ${response.access_token}`;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        const errorMsg = process.platform === 'win32' 
          ? 'Failed to load credentials: Claude credentials file not found in WSL. Check your default WSL distro with "wsl -l -v" and set the correct one with "wsl --set-default <distro-name>". As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)'
          : 'Claude credentials not found. Please ensure Claude Code is installed and you have logged in. As a backup, you can get the token from ~/.claude/.credentials.json and pass it as x-api-key (proxy password in SillyTavern)';
        Logger.error('ENOENT error during token refresh:', errorMsg);
        throw new Error(errorMsg);
      }
      if (error.message.includes('invalid_grant')) {
        const err = new Error('Refresh token expired. Please log in again through Claude Code');
        err.code = 'INVALID_GRANT';
        throw err;
      }
      if (error.message.includes('timeout')) {
        throw new Error('Token refresh timeout. Please check your internet connection');
      }
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }

  getHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'anthropic-version': this.VERSION,
      'User-Agent': 'claude-code-proxy/1.0.0'
    };

    if (this.BETA_HEADER) {
      headers['anthropic-beta'] = this.BETA_HEADER;
    }

    return headers;
  }

  static proxyMessage(text) {
    return {
      id: 'msg_proxy',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: `[Proxy] ${text}` }],
      model: 'proxy',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    };
  }

  static forwardResponseHeaders(source, target) {
    const ALLOWED_EXACT = new Set([
      'content-type',
      'request-id',
      'retry-after',
      'cf-ray',
    ]);

    const ALLOWED_PREFIXES = [
      'x-ratelimit-',
      'anthropic-ratelimit-',
    ];

    const dropped = [];

    for (const key of Object.keys(source.headers)) {
      const lower = key.toLowerCase();
      if (ALLOWED_EXACT.has(lower) || ALLOWED_PREFIXES.some(p => lower.startsWith(p))) {
        target.setHeader(key, source.headers[key]);
      } else {
        dropped.push(key);
      }
    }

    if (dropped.length > 0) {
      Logger.debug(`Response headers dropped by allowlist: ${dropped.join(', ')}`);
    }
  }

  processRequestBody(body, presetName = null) {
    if (!body) return body;

    const systemPrompt = {
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    };

    if (body.system) {
      if (Array.isArray(body.system)) {
        body.system.unshift(systemPrompt);
      } else {
        body.system = [systemPrompt, body.system];
      }
    } else {
      body.system = [systemPrompt];
    }

    if (presetName) {
      this.applyPreset(body, presetName);
    }

    body = this.stripTtlFromCacheControl(body);
    body = this.filterSamplingParams(body);
    this.injectCacheBreakpoints(body);

    return body;
  }

  injectCacheBreakpoints(body) {
    if (!body || !INJECT_CACHE_BREAKPOINTS) return;

    const target = Array.isArray(body.tools) && body.tools.length > 0
      ? body.tools[body.tools.length - 1]
      : Array.isArray(body.system) && body.system.length > 0
        ? body.system[body.system.length - 1]
        : null;

    if (target) {
      target.cache_control = { type: 'ephemeral' };
    }
  }

  loadPreset(presetName) {
    if (ClaudeRequest.presetCache.has(presetName)) {
      return ClaudeRequest.presetCache.get(presetName);
    }

    try {
      const presetPath = path.join(__dirname, 'presets', `${presetName}.json`);
      const presetData = fs.readFileSync(presetPath, 'utf8');
      const preset = JSON.parse(presetData);
      ClaudeRequest.presetCache.set(presetName, preset);
      return preset;
    } catch (error) {
      Logger.info(`Failed to load preset ${presetName}: ${error.message}`);
      ClaudeRequest.presetCache.set(presetName, null);
      return null;
    }
  }

  applyPreset(body, presetName) {
    const preset = this.loadPreset(presetName);
    if (!preset) {
      Logger.warn(`Unknown preset: ${presetName}`);
      return;
    }

    if (preset.system) {
      const presetSystemPrompt = {
        type: 'text',
        text: preset.system
      };
      body.system.push(presetSystemPrompt);
    }

    // Use suffixEt only when thinking is enabled, otherwise use regular suffix
    const hasThinking = body.thinking && body.thinking.type === 'enabled';
    const suffix = hasThinking ? preset.suffixEt : preset.suffix;
    
    if (suffix && body.messages && body.messages.length > 0) {
      const lastUserIndex = body.messages.map(m => m.role).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        const suffixMsg = {
          role: 'user',
          content: [{ type: 'text', text: suffix }]
        };
        body.messages.splice(lastUserIndex + 1, 0, suffixMsg);
      }
    }

    Logger.debug(`Applied preset: ${presetName}`);
  }

  async makeRequest(body, presetName = null) {
    const token = await this.getAuthToken();
    const headers = this.getHeaders(token);
    const processedBody = this.processRequestBody(body, presetName);

    Logger.headers('Outgoing headers to Claude', headers);
    Logger.body('Final request to Claude', processedBody);

    const urlParts = new URL(this.API_URL);
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: urlParts.pathname,
      method: 'POST',
      headers: headers
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        resolve(res);
      });

      req.on('error', (err) => {
        Logger.error(`${this.logTag}Network error connecting to Claude API: ${err.message}`);
        req.destroy();
        reject(err);
      });

      req.setTimeout(120000, () => {
        Logger.error(`${this.logTag}Claude API request timed out (120s)`);
        req.destroy();
        reject(new Error('Claude API request timeout'));
      });

      req.write(JSON.stringify(processedBody));
      req.end();
    });
  }

  async handleResponse(res, body, presetName = null) {
    try {
      const claudeResponse = await this.makeRequest(body, presetName);
      
      if (claudeResponse.statusCode === 401 && !this.passthroughToken) {
        Logger.info(`${this.logTag}Got 401, refreshing token`);
        OAuthManager.cachedToken = null;

        try {
          await this.loadOrRefreshToken();
          const retryResponse = await this.makeRequest(body, presetName);
          res.statusCode = retryResponse.statusCode;
          Logger.info(`${this.logTag}Token refreshed, retry status: ${retryResponse.statusCode}`);
          Logger.headers('Claude retry response headers', retryResponse.headers);
          ClaudeRequest.forwardResponseHeaders(retryResponse, res);
          this.streamResponse(res, retryResponse);
          return;
        } catch (error) {
          if (error.code === 'INVALID_GRANT') {
            Logger.warn(`${this.logTag}Returning re-authorization message to client (401 retry path)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ClaudeRequest.proxyMessage('OAuth session expired. Please re-authorize.')));
            return;
          }
          Logger.warn(`${this.logTag}Token refresh failed, passing 401 to client: ${error.message}`);
        }
      }
      
      res.statusCode = claudeResponse.statusCode;
      if (claudeResponse.statusCode >= 400) {
        Logger.warn(`${this.logTag}Claude API returned ${claudeResponse.statusCode}`);
      } else {
        Logger.debug(`${this.logTag}Claude API status: ${claudeResponse.statusCode}`);
      }
      Logger.headers('Claude response headers', claudeResponse.headers);
      ClaudeRequest.forwardResponseHeaders(claudeResponse, res);
      
      this.streamResponse(res, claudeResponse);
      
    } catch (error) {
      if (error.code === 'INVALID_GRANT') {
        Logger.warn(`${this.logTag}Returning re-authorization message to client`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ClaudeRequest.proxyMessage('OAuth session expired. Please re-authorize.')));
        return;
      }
      const status = error.statusCode || 500;
      Logger.error(`${this.logTag}Claude request error (${status}):`, error.message);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  streamResponse(res, claudeResponse) {
    const extractClaudeText = (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') {
                return { text: data.delta.text };
              }
              if (data.delta?.type === 'thinking_delta') {
                return { thinking: data.delta.thinking };
              }
            }
          }
        }
      } catch (e) {
        Logger.trace('SSE chunk parse error:', e.message);
      }
      return null;
    };

    const contentType = claudeResponse.headers['content-type'] || '';
    if (contentType.includes('text/event-stream')) {
      Logger.headers('Outgoing response headers to client', res.getHeaders());

      const stats = { model: null, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, stopReason: null };
      const statsStream = new Transform({
        transform(chunk, encoding, callback) {
          try {
            for (const line of chunk.toString().split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const data = JSON.parse(line.substring(6));
                if (data.type === 'message_start' && data.message) {
                  stats.model = data.message.model;
                  const u = data.message.usage;
                  if (u) {
                    stats.inputTokens = u.input_tokens || 0;
                    stats.cacheCreation = u.cache_creation_input_tokens || 0;
                    stats.cacheRead = u.cache_read_input_tokens || 0;
                  }
                } else if (data.type === 'message_delta') {
                  if (data.delta?.stop_reason) stats.stopReason = data.delta.stop_reason;
                  if (data.usage) stats.outputTokens = data.usage.output_tokens || 0;
                }
              } catch (e) { /* partial JSON */ }
            }
          } catch (e) { /* ignore */ }
          callback(null, chunk);
        }
      });

      const logStats = () => {
        let msg = `${this.logTag}Response: in=${stats.inputTokens}`;
        msg += ` (cache_write=${stats.cacheCreation}, cache_read=${stats.cacheRead})`;
        msg += `, out=${stats.outputTokens}, stop=${stats.stopReason}, model=${stats.model}`;
        Logger.info(msg);
      };

      claudeResponse.on('error', (err) => {
        Logger.error(`${this.logTag}Claude SSE stream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream response error' }));
        }
      });

      res.on('close', () => {
        Logger.debug('Client disconnected, cleaning up streams');
        if (!claudeResponse.destroyed) {
          claudeResponse.destroy();
        }
      });

      if (Logger.getLogLevel() >= 3) {
        const debugStream = Logger.createDebugStream('Claude SSE', extractClaudeText);

        debugStream.on('error', (err) => {
          Logger.error(`${this.logTag}Debug stream processing error: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          if (!res.destroyed) {
            res.end(JSON.stringify({ error: 'Stream processing error' }));
          }
        });

        claudeResponse.pipe(statsStream).pipe(debugStream).pipe(res);
        debugStream.on('end', () => {
          Logger.debug('\n');
          Logger.debug('Streaming response sent back to client');
          logStats();
        });
      } else {
        claudeResponse.pipe(statsStream).pipe(res);
        statsStream.on('end', () => {
          logStats();
        });
      }
    } else {
      let responseData = '';
      claudeResponse.on('data', chunk => {
        responseData += chunk;
      });

      claudeResponse.on('error', (err) => {
        Logger.error(`${this.logTag}Claude non-streaming response error:`, err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream error', message: err.message }));
        }
      });

      claudeResponse.on('end', () => {
        Logger.debug(`Non-streaming response (${claudeResponse.statusCode}): ${responseData.substring(0, 500)}`);
        try {
          const jsonData = JSON.parse(responseData);

          if (jsonData.usage) {
            const u = jsonData.usage;
            let msg = `${this.logTag}Response: in=${u.input_tokens || 0}`;
            msg += ` (cache_write=${u.cache_creation_input_tokens || 0}, cache_read=${u.cache_read_input_tokens || 0})`;
            msg += `, out=${u.output_tokens || 0}, stop=${jsonData.stop_reason}, model=${jsonData.model}`;
            Logger.info(msg);
          }

          res.setHeader('Content-Type', 'application/json');
          Logger.headers('Outgoing response headers to client', res.getHeaders());
          res.end(JSON.stringify(jsonData));
          Logger.debug('Non-streaming response sent back to client');
        } catch (e) {
          Logger.warn(`${this.logTag}Non-JSON response from Claude (${claudeResponse.statusCode}), forwarding raw`);
          res.end(responseData);
        }
      });
    }
  }

  async refreshTokenWithClaudeCodeCli() {
    throw new Error('CLI token refresh not implemented');
  }
}

module.exports = ClaudeRequest;
