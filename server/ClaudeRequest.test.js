const { Readable, Writable } = require('stream');
const zlib = require('zlib');
const ClaudeRequest = require('./ClaudeRequest');

jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  trace: jest.fn(),
  headers: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0),
  createDebugStream: jest.fn()
}));

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.chunks = [];
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeaders() {
    return this.headers;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
    return this;
  }

  end(chunk, encoding, callback) {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }
    return super.end(callback);
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function makeClaudeResponse(body, headers) {
  const response = Readable.from([body]);
  response.headers = headers;
  response.statusCode = 200;
  return response;
}

function waitForFinish(stream) {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

describe('ClaudeRequest streamResponse', () => {
  it('decompresses gzip JSON before parsing non-streaming responses', async () => {
    const request = new ClaudeRequest('test-token');
    const clientResponse = new CaptureResponse();
    const body = {
      id: 'msg_123',
      type: 'message',
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
      model: 'claude-test'
    };
    const claudeResponse = makeClaudeResponse(
      zlib.gzipSync(JSON.stringify(body)),
      {
        'content-type': 'application/json',
        'content-encoding': 'gzip'
      }
    );

    request.streamResponse(clientResponse, claudeResponse);
    await waitForFinish(clientResponse);

    expect(clientResponse.headers['content-type']).toBe('application/json');
    expect(JSON.parse(clientResponse.text())).toEqual(body);
  });

  it('decompresses gzip SSE before forwarding streaming responses', async () => {
    const request = new ClaudeRequest('test-token');
    const clientResponse = new CaptureResponse();
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
      '',
      ''
    ].join('\n');
    const claudeResponse = makeClaudeResponse(
      zlib.gzipSync(sse),
      {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip'
      }
    );

    request.streamResponse(clientResponse, claudeResponse);
    await waitForFinish(clientResponse);

    expect(clientResponse.text()).toBe(sse);
  });
});
