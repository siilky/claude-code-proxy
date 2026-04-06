const request = require('supertest');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nock = require('nock');

// Mock Logger before requiring server
jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0)
}));

const OAuthManager = require('./OAuthManager');

// Import server components after mocking
const url = require('url');
const parseBody = (req) => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
};

describe('OAuth Routes Integration Tests', () => {
  let server;
  let testTokenPath;
  let pkceStates;

  beforeAll(() => {
    // Mock the config file
    const configPath = path.join(__dirname, 'config.txt');
    const originalReadFileSync = fs.readFileSync;

    jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
      if (filePath === configPath) {
        return 'port=42069\nhost=\nlog_level=INFO\nauto_open_browser=false\nfallback_to_claude_code=false';
      }
      return originalReadFileSync(filePath, encoding);
    });
  });

  beforeEach(() => {
    // Use a temporary directory for testing
    testTokenPath = path.join(__dirname, '.test-tokens-integration', 'tokens.json');
    OAuthManager.tokenPath = testTokenPath;
    OAuthManager.cachedToken = null;
    OAuthManager.refreshPromise = null;

    // Clean up test directory
    const testDir = path.dirname(testTokenPath);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }

    // Initialize PKCE states map
    pkceStates = new Map();

    // Create test server with OAuth routes
    const handleRequest = async (req, res) => {
      const parsedUrl = url.parse(req.url, true);
      const pathname = parsedUrl.pathname;

      // OAuth Routes
      if (pathname === '/auth/login' && req.method === 'GET') {
        try {
          const pkce = OAuthManager.generatePKCE();
          pkceStates.set(pkce.state, {
            code_verifier: pkce.code_verifier,
            created_at: Date.now()
          });

          const authUrl = OAuthManager.buildAuthorizationURL(pkce);
          res.writeHead(302, { 'Location': authUrl });
          res.end();
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to initiate OAuth login' }));
        }
        return;
      }

      if (pathname === '/auth/callback' && req.method === 'GET') {
        try {
          const query = parsedUrl.query;
          const code = query.code;
          const state = query.state;

          if (!code || !state) {
            throw new Error('Missing authorization code or state');
          }

          const pkceData = pkceStates.get(state);
          if (!pkceData) {
            throw new Error('Invalid or expired state parameter');
          }

          pkceStates.delete(state);

          const tokens = await OAuthManager.exchangeCodeForTokens(code, pkceData.code_verifier);

          const tokenData = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in * 1000)
          };
          OAuthManager.saveTokens(tokenData);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication Successful!</h1></body></html>');
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Authentication Failed</title></head>
            <body>
              <h1>Authentication Failed</h1>
              <p>Error: ${error.message}</p>
            </body>
            </html>
          `);
        }
        return;
      }

      if (pathname === '/auth/status' && req.method === 'GET') {
        try {
          const isAuthenticated = OAuthManager.isAuthenticated();
          const expiration = OAuthManager.getTokenExpiration();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            authenticated: isAuthenticated,
            expires_at: expiration ? expiration.toISOString() : null
          }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to check authentication status' }));
        }
        return;
      }

      if (pathname === '/auth/logout' && req.method === 'GET') {
        try {
          OAuthManager.logout();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to logout' }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    };

    server = http.createServer(handleRequest);

    // Start server on a random port for testing
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
  });

  afterEach((done) => {
    // Clean up
    const testDir = path.dirname(testTokenPath);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    nock.cleanAll();

    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('GET /auth/login', () => {
    it('should redirect to OAuth authorization URL', async () => {
      const response = await request(server).get('/auth/login');

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('https://claude.ai/oauth/authorize');
      expect(response.headers.location).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(response.headers.location).toContain('response_type=code');
      expect(response.headers.location).toContain('code_challenge=');
      expect(response.headers.location).toContain('code_challenge_method=S256');
      expect(response.headers.location).toContain('state=');
    });

    it('should store PKCE state for callback verification', async () => {
      const response = await request(server).get('/auth/login');

      const locationUrl = new URL(response.headers.location);
      const state = locationUrl.searchParams.get('state');

      expect(pkceStates.has(state)).toBe(true);
      expect(pkceStates.get(state)).toHaveProperty('code_verifier');
      expect(pkceStates.get(state)).toHaveProperty('created_at');
    });
  });

  describe('GET /auth/callback', () => {
    it('should exchange code for tokens and save them', async () => {
      // First, initiate login to get state
      const loginResponse = await request(server).get('/auth/login');
      const locationUrl = new URL(loginResponse.headers.location);
      const state = locationUrl.searchParams.get('state');

      // Mock the token exchange
      const mockTokens = {
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(200, mockTokens);

      // Make callback request
      const response = await request(server)
        .get(`/auth/callback?code=test-code&state=${state}`);

      expect(response.status).toBe(200);
      expect(response.text).toContain('Authentication Successful');

      // Verify tokens were saved
      const savedTokens = OAuthManager.loadTokens();
      expect(savedTokens).toBeTruthy();
      expect(savedTokens.access_token).toBe('mock-access-token');
      expect(savedTokens.refresh_token).toBe('mock-refresh-token');
    });

    it('should return error if code is missing', async () => {
      const response = await request(server)
        .get('/auth/callback?state=test-state');

      expect(response.status).toBe(500);
      expect(response.text).toContain('Authentication Failed');
      expect(response.text).toContain('Missing authorization code or state');
    });

    it('should return error if state is missing', async () => {
      const response = await request(server)
        .get('/auth/callback?code=test-code');

      expect(response.status).toBe(500);
      expect(response.text).toContain('Authentication Failed');
      expect(response.text).toContain('Missing authorization code or state');
    });

    it('should return error if state is invalid', async () => {
      const response = await request(server)
        .get('/auth/callback?code=test-code&state=invalid-state');

      expect(response.status).toBe(500);
      expect(response.text).toContain('Authentication Failed');
      expect(response.text).toContain('Invalid or expired state parameter');
    });

    it('should delete state after successful callback', async () => {
      // First, initiate login to get state
      const loginResponse = await request(server).get('/auth/login');
      const locationUrl = new URL(loginResponse.headers.location);
      const state = locationUrl.searchParams.get('state');

      expect(pkceStates.has(state)).toBe(true);

      // Mock the token exchange
      const mockTokens = {
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_in: 3600
      };

      nock('https://console.anthropic.com')
        .post('/v1/oauth/token')
        .reply(200, mockTokens);

      // Make callback request
      await request(server)
        .get(`/auth/callback?code=test-code&state=${state}`);

      // State should be deleted
      expect(pkceStates.has(state)).toBe(false);
    });
  });

  describe('GET /auth/status', () => {
    it('should return not authenticated when no tokens exist', async () => {
      const response = await request(server).get('/auth/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        authenticated: false,
        expires_at: null
      });
    });

    it('should return authenticated when tokens exist', async () => {
      const expiresAt = Date.now() + 3600000;
      const tokens = {
        access_token: 'test-token',
        refresh_token: 'test-refresh-token',
        expires_at: expiresAt
      };
      OAuthManager.saveTokens(tokens);

      const response = await request(server).get('/auth/status');

      expect(response.status).toBe(200);
      expect(response.body.authenticated).toBe(true);
      expect(response.body.expires_at).toBeTruthy();
    });
  });

  describe('GET /auth/logout', () => {
    it('should delete tokens and return success', async () => {
      // Save some tokens first
      const tokens = {
        access_token: 'test-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 3600000
      };
      OAuthManager.saveTokens(tokens);

      expect(OAuthManager.isAuthenticated()).toBe(true);

      const response = await request(server).get('/auth/logout');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'Logged out successfully'
      });

      expect(OAuthManager.isAuthenticated()).toBe(false);
    });

    it('should succeed even if no tokens exist', async () => {
      const response = await request(server).get('/auth/logout');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'Logged out successfully'
      });
    });
  });

  describe('No CORS headers', () => {
    it('should not include CORS headers in responses', async () => {
      const response = await request(server).get('/auth/status');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
      expect(response.headers['access-control-allow-headers']).toBeUndefined();
    });
  });
});
