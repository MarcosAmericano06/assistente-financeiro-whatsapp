import { pino } from 'pino';

// Redação: nunca logar segredos nem payloads financeiros completos.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.password',
      '*.secret',
      '*.token',
      '*.apiKey',
      '*.clientSecret',
      'req.headers.authorization',
      'transaction.description',
      'transaction.merchant',
    ],
    censor: '[redacted]',
  },
});
