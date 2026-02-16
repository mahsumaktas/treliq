/**
 * Structured logging with Pino
 *
 * Provides consistent, structured logging across all modules.
 * - Development: Pretty-printed, colorized output
 * - Production: JSON format for log aggregation
 * - Sensitive data (tokens, API keys) automatically redacted
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: !isProduction
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
  redact: [
    'token',
    'apiKey',
    'privateKey',
    'secret',
    'password',
    '*.token',
    '*.apiKey',
    '*.privateKey',
    '*.secret',
    '*.password',
    'headers.authorization',
  ],
});

/**
 * Create a child logger scoped to a module
 *
 * @example
 * const log = createLogger('scanner');
 * log.info({ repo: 'owner/repo' }, 'Fetching open PRs');
 * log.error({ err }, 'Failed to fetch PRs');
 */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export default logger;
