import Fastify from 'fastify';
import { loadConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { createDb } from './db/index.js';
import { sql } from 'drizzle-orm';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const app = Fastify({ loggerInstance: logger });

app.get('/health', async () => {
  await db.execute(sql`select 1`);
  return { status: 'ok', env: config.NODE_ENV };
});

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(`bot-financeiro ouvindo na porta ${config.PORT}`);
} catch (err) {
  logger.error(err, 'falha ao subir o servidor');
  process.exit(1);
}
