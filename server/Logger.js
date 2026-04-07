const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');

const SENSITIVE_HEADERS = new Set([
  'authorization', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization'
]);

function maskValue(value) {
  const s = String(value);
  if (s.length <= 12) return '***';
  return s.slice(0, 4) + '...' + s.slice(-4);
}

function formatArgs(args) {
  return args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ');
}

class Logger {
  static _logStream = null;
  static _currentDate = null;
  static _logDir = null;

  static init(config) {
    this.config = config;
    this._initFileLogging();
  }

  static _initFileLogging() {
    const logDir = this.config?.log_dir;
    if (!logDir) return;

    this._logDir = path.resolve(logDir);
    fs.mkdirSync(this._logDir, { recursive: true });
    this._openStream();
    this._cleanOldLogs();
  }

  static _dateString() {
    return new Date().toISOString().slice(0, 10);
  }

  static _openStream() {
    this._currentDate = this._dateString();
    const logPath = path.join(this._logDir, `${this._currentDate}.log`);
    this._logStream = fs.createWriteStream(logPath, { flags: 'a' });
  }

  static _rotateIfNeeded() {
    const today = this._dateString();
    if (today === this._currentDate) return;
    if (this._logStream) this._logStream.end();
    this._openStream();
    this._cleanOldLogs();
  }

  static _writeToFile(level, args) {
    if (!this._logStream) return;
    this._rotateIfNeeded();
    const ts = new Date().toISOString();
    this._logStream.write(`${ts} ${level}: ${formatArgs(args)}\n`);
  }

  static _cleanOldLogs() {
    const days = Number(this.config?.log_retention_days) || 30;
    const cutoff = Date.now() - days * 86400000;
    let files;
    try { files = fs.readdirSync(this._logDir); } catch { return; }
    for (const f of files) {
      const match = f.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (match && new Date(match[1]).getTime() < cutoff) {
        fs.unlink(path.join(this._logDir, f), () => {});
      }
    }
  }

  static getLogLevel() {
    const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
    return levels[this.config?.log_level] || 2;
  }

  static debug(...args) {
    if (this.getLogLevel() >= 3) {
      console.log('DEBUG:', ...args);
      this._writeToFile('DEBUG', args);
    }
  }

  static trace(...args) {
    if (this.getLogLevel() >= 4) {
      console.log('TRACE:', ...args);
      this._writeToFile('TRACE', args);
    }
  }

  static info(...args) {
    if (this.getLogLevel() >= 2) {
      console.log('INFO:', ...args);
      this._writeToFile('INFO', args);
    }
  }

  static warn(...args) {
    if (this.getLogLevel() >= 1) {
      console.warn('WARN:', ...args);
      this._writeToFile('WARN', args);
    }
  }

  static error(...args) {
    console.error('ERROR:', ...args);
    this._writeToFile('ERROR', args);
  }

  static headers(label, headers) {
    if (this.getLogLevel() < 3) return;
    const safe = {};
    for (const [key, value] of Object.entries(headers)) {
      safe[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
        ? maskValue(value)
        : value;
    }
    this.debug(`${label}:`, JSON.stringify(safe, null, 2));
  }

  static body(label, body) {
    if (this.getLogLevel() < 3 || !body || typeof body !== 'object') return;
    const size = JSON.stringify(body).length;
    this.debug(`${label} (${size} bytes): model=${body.model}, messages=${body.messages?.length}, stream=${body.stream}`);
    this.trace(`${label} full:`, JSON.stringify(body, null, 2));
  }

  /**
   * Log an error with consistent formatting:
   * - At the given level: message + error.message
   * - At DEBUG: full stack trace (if available)
   */
  static logError(level, message, error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    this[level](`${message}: ${errorMsg}`);
    if (error instanceof Error && error.stack && this.getLogLevel() >= 3) {
      this.debug('Stack trace:', error.stack);
    }
  }

  static createDebugStream(label = 'Stream chunk', textExtractor = null) {
    if (this.getLogLevel() < 3) {
      return new Transform({
        transform(chunk, encoding, callback) {
          callback(null, chunk);
        }
      });
    }

    let streamingText = '';
    let thinkingText = '';
    let hasStartedStreaming = false;
    let hasStartedResponse = false;
    const logLevel = this.getLogLevel();
    
    return new Transform({
      transform(chunk, encoding, callback) {
        try {
          const chunkStr = chunk.toString();
          
          if (logLevel >= 4) {
            Logger.trace(`${label} (${chunkStr.length} bytes): ${chunkStr}`);
          } else if (logLevel >= 3) {
            if (textExtractor) {
              const result = textExtractor(chunk);
              if (result?.text) {
                if (!hasStartedStreaming) {
                  Logger.debug(`${label} streaming started`);
                  hasStartedStreaming = true;
                }
                if (thinkingText && !hasStartedResponse) {
                  process.stdout.write('\n');
                  Logger.debug(`${label} switching from thinking to response`);
                  hasStartedResponse = true;
                }
                streamingText += result.text;
                process.stdout.write(result.text);
              }
              if (result?.thinking) {
                if (!hasStartedStreaming) {
                  Logger.debug(`${label} streaming started`);
                  hasStartedStreaming = true;
                }
                thinkingText += result.thinking;
                process.stdout.write(`\x1b[90m${result.thinking}\x1b[0m`);
              }
            } else {
              Logger.debug(`${label} (${chunkStr.length} bytes): ${chunkStr}`);
            }
          }
        } catch (error) {
          Logger.warn(`${label}: failed to decode stream chunk (${chunk.length} bytes): ${error.message}`);
        }
        callback(null, chunk);
      }
    });
  }

}

module.exports = Logger;