import type { Db } from '../db/index.js';

export type TxType = 'expense' | 'income' | 'transfer' | 'card_payment' | 'investment' | 'refund' | 'adjustment';
export const TX_TYPES: TxType[] = ['expense', 'income', 'transfer', 'card_payment', 'investment', 'refund', 'adjustment'];

// Funções de domínio aceitam o banco ou uma transação aberta (db.transaction).
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type Necessity = 'necessario' | 'desnecessario' | 'doacao';
export const NECESSITIES: Necessity[] = ['necessario', 'desnecessario', 'doacao'];
export const NECESSITY_LABEL: Record<Necessity, string> = { necessario: 'Necessário', desnecessario: 'Desnecessário', doacao: 'Doação' };
export const NECESSITY_EMOJI: Record<Necessity, string> = { necessario: '🟢', desnecessario: '🔴', doacao: '🎁' };
