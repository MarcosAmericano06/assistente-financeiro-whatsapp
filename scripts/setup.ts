// Primeira configuração (e reconfiguração) do bot a partir de setup.json.
// Uso: npx tsx --env-file=.env scripts/setup.ts
import { readFileSync } from 'node:fs';
import { createDb } from '../src/db/index.js';
import { applySetup, type SetupConfig } from '../src/setup/apply.js';

const cfg = JSON.parse(readFileSync('setup.json', 'utf8')) as SetupConfig;
const db = createDb(process.env.DATABASE_URL!);
console.log(JSON.stringify(await applySetup(db, cfg), null, 2));
process.exit(0);
