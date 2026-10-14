import { loadConfig } from '../core/config.js';
import { createDb } from '../db/index.js';
import { PluggyClient } from './pluggy-client.js';
import { syncItem, spentThisMonth } from './sync.js';

const config = loadConfig();
const itemIds = (process.env.PLUGGY_ITEM_IDS ?? process.env.PLUGGY_ITEM_ID ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!itemIds.length) throw new Error('PLUGGY_ITEM_IDS não definido');

const db = createDb(config.DATABASE_URL);
const pluggy = new PluggyClient(config.PLUGGY_CLIENT_ID, config.PLUGGY_CLIENT_SECRET);

for (const itemId of itemIds) {
  const result = await syncItem(db, pluggy, itemId);
  console.log(`\n=== SYNC ${itemId.slice(0, 8)}... ===`);
  console.log(result);
}

const spent = await spentThisMonth(db);
console.log('\n=== GASTOS DO MÊS ATUAL (calculado pelo banco) ===');
console.log('Total: R$', spent.total);
console.table(spent.byCategory);

process.exit(0);
