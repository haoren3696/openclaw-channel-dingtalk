import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger, RetryOptions } from './src/types';

/**
 * Mask sensitive fields in data for safe logging
 * Prevents PII leakage in debug logs
 */
export function maskSensitiveData(data: unknown): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data as string | number;
  }

  const masked = JSON.parse(JSON.stringify(data)) as Record<string, any>;
  const sensitiveFields = ['token', 'accessToken'];

  function maskObj(obj: any): void {
    for (const key in obj) {
      if (sensitiveFields.includes(key)) {
        const val = obj[key];
        if (typeof val === 'string' && val.length > 6) {
          obj[key] = val.slice(0, 3) + '*'.repeat(val.length - 6) + val.slice(-3);
        } else if (typeof val === 'string') {
          obj[key] = '*'.repeat(val.length);
        }
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        maskObj(obj[key]);
      }
    }
  }

  maskObj(masked);
  return masked;
}

/**
 * Cleanup orphaned temp files from dingtalk media
 * Run at startup to clean up files from crashed processes
 */
export function cleanupOrphanedTempFiles(log?: Logger): number {
  const tempDir = os.tmpdir();
  const dingtalkPattern = /^dingtalk_\d+\..+$/;
  let cleaned = 0;

  try {
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!dingtalkPattern.test(file)) continue;

      const filePath = path.join(tempDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
          log?.debug?.(`[DingTalk] Cleaned up orphaned temp file: ${file}`);
        }
      } catch (err: any) {
        log?.debug?.(`[DingTalk] Failed to cleanup temp file ${file}: ${err.message}`);
      }
    }

    if (cleaned > 0) {
      log?.info?.(`[DingTalk] Cleaned up ${cleaned} orphaned temp files`);
    }
  } catch (err: any) {
    log?.debug?.(`[DingTalk] Failed to cleanup temp directory: ${err.message}`);
  }

  return cleaned;
}

/**
 * Retry logic for API calls with exponential backoff
 * Handles transient failures like 401 token expiry
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 100, log } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const statusCode = err.response?.status;
      const isRetryable = statusCode === 401 || statusCode === 429 || (statusCode && statusCode >= 500);

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      log?.debug?.(`[DingTalk] Retry attempt ${attempt}/${maxRetries} after ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Retry exhausted without returning');
}

/**
 * Parse stack trace to get caller file and line information
 * Returns { filename, line } or null if parsing fails
 */
function parseCallerLocation(stack: string): { filename: string; line: number } | null {
  const lines = stack.split('\n');
  // Skip first 3 lines: Error message + this function + wrapper function
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match patterns like: at functionName (file:line:column) or at file:line:column
    const match = line.match(/at\s+(?:.+\s+)?\(([^)]+)\)|at\s+(.+)/);
    if (match) {
      const location = match[1] || match[2];
      if (location) {
        // Extract filename and line from location like "file.ts:123:45" or "/path/to/file.ts:123:45"
        const parts = location.split(':');
        if (parts.length >= 2) {
          const filename = path.basename(parts[0]);
          const lineNum = parseInt(parts[1], 10);
          if (!isNaN(lineNum)) {
            return { filename, line: lineNum };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Create a logger wrapper that adds file and line number information to all log messages
 * Usage: const log = createLoggerWithLocation(originalLog, __filename);
 *        log.info?.('Message'); // Outputs: [file.ts:123] Message
 */
export function createLoggerWithLocation(
  originalLog: Logger | undefined,
  defaultFilename?: string
): Logger | undefined {
  if (!originalLog) {
    return undefined;
  }

  const filename = defaultFilename ? path.basename(defaultFilename) : 'unknown';

  function getLocation(): string {
    const err = new Error();
    const location = parseCallerLocation(err.stack || '');
    if (location) {
      return `[${location.filename}:${location.line}]`;
    }
    return `[${filename}:?]`;
  }

  function wrapLogMethod(method: 'info' | 'debug' | 'error' | 'warn') {
    return function (this: any, message?: string, ...args: any[]) {
      if (!originalLog) return;

      const location = getLocation();
      const prefix = `${location}`;

      // Format the message with location prefix
      let formattedMessage: string;
      if (typeof message === 'string') {
        formattedMessage = `${prefix} ${message}`;
      } else {
        formattedMessage = prefix;
      }

      // Call original method
      const originalMethod = originalLog[method];
      if (originalMethod) {
        return originalMethod.call(this, formattedMessage, ...args);
      }
    };
  }

  return {
    info: wrapLogMethod('info'),
    debug: wrapLogMethod('debug'),
    error: wrapLogMethod('error'),
    warn: wrapLogMethod('warn'),
  } as Logger;
}

/**
 * Wrap an existing logger with file/line location info
 * This is a convenience wrapper that can be used inline
 * Usage: logWithLocation(log).info('Message');
 */
export function logWithLocation(log: Logger | undefined, defaultFilename?: string): Logger | undefined {
  return createLoggerWithLocation(log, defaultFilename);
}
