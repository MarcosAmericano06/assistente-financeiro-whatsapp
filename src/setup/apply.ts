// Aplica a configuração pessoal do dono (setup.json): nomes dele e da família como
// aparecem nos PIX, projetos de tarefas e padrões de pagamento de fatura. Idempotente.
import { sql } from 'drizzle-orm';
import { newBatchId } from '../finance/audit.js';
import { loadRules, normalizeText, upsertRule } from '../finance/rules.js';
import { setSetting } from '../finance/settings.js';
import { seedTaxonomy } from '../finance/taxonomy.js';
import type { DbOrTx } from '../finance/types.js';

export interface SetupConfig {
  ownerName: string;
  ownNames: string[]; // como o nome do dono aparece nas transferências entre as contas dele
  family: string[]; // nomes da família como aparecem nos PIX (repasses viram transferência)
  projects: string[]; // projetos das tarefas
  cardPaymentPatterns: string[]; // trechos de descrição de pagamento de fatura feito pela conta corrente
}

export async function applySetup(db: DbOrTx, cfg: SetupConfig): Promise<{ ownerId: string; categoriasCriadas: number; regrasDeFatura: number }> {
  const clean = (xs: string[]) => [...new Set(xs.map(normalizeText).filter((x) => x.length >= 3))];
  const [found] = (await db.execute(sql`select id::text from users where role='owner' limit 1`)) as unknown as { id: string }[];
  const ownerId =
    found?.id ??
    ((await db.execute(sql`insert into users (name, role) values (${cfg.ownerName}, 'owner') returning id::text`))[0] as { id: string }).id;
  await db.execute(sql`update users set name=${cfg.ownerName} where id=${ownerId}::uuid`);

  const { criadas } = await seedTaxonomy(db, ownerId);
  await setSetting(db, ownerId, 'own_names', clean(cfg.ownNames));
  await setSetting(db, ownerId, 'family_patterns', clean(cfg.family));
  await setSetting(db, ownerId, 'task_projects', cfg.projects.map((p) => p.trim()).filter(Boolean));

  const existing = await loadRules(db);
  let regras = 0;
  for (const pattern of clean(cfg.cardPaymentPatterns)) {
    if (existing.some((r) => r.pattern === pattern && r.setType === 'card_payment')) continue;
    await upsertRule(db, ownerId, { pattern, setType: 'card_payment', origin: 'system' }, { batchId: newBatchId(), origin: 'setup' });
    regras++;
  }
  return { ownerId, categoriasCriadas: criadas, regrasDeFatura: regras };
}
