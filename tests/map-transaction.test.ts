import { describe, it, expect } from 'vitest';
import { mapTransaction } from '../src/ingestion/sync.js';
import type { PluggyTransaction } from '../src/ingestion/pluggy-client.js';

const tx = (description: string, amount: number, category: string | null = null, merchant?: string): PluggyTransaction => ({
  id: 'x',
  accountId: 'a',
  date: '2026-09-10T00:00:00.000Z',
  description,
  amount,
  currencyCode: 'BRL',
  category,
  status: 'POSTED',
  merchant: merchant ? { name: merchant } : null,
});

describe('mapTransaction — cartão (CREDIT)', () => {
  it('compra (positivo) é gasto', () => {
    expect(mapTransaction(tx('IFOOD', 45.9), 'CREDIT')).toEqual({ type: 'expense', amount: '45.90' });
  });

  it.each(['Pagamento de fatura', 'Pagamento recebido', 'Pagamentos Validos Normais', 'Pagamento PIX'])(
    'crédito "%s" é pagamento de fatura',
    (d) => {
      expect(mapTransaction(tx(d, -1000), 'CREDIT').type).toBe('card_payment');
    },
  );

  it('crédito com categoria "Credit card payment" é pagamento de fatura', () => {
    expect(mapTransaction(tx('XYZ', -500, 'Credit card payment'), 'CREDIT').type).toBe('card_payment');
  });

  it.each(['PAGTO FATURA', 'PGTO DEBITO AUTOMATICO', 'Fatura paga', 'DEBITO AUTOMATICO FATURA'])(
    'variação de pagamento "%s" continua sendo pagamento de fatura, nunca estorno',
    (d) => {
      expect(mapTransaction(tx(d, -10000), 'CREDIT').type).toBe('card_payment');
    },
  );

  it.each(['LATAM DCP ND*DJLW', 'ESTORNO JUROS DE MORA', 'CREDITO PROV CONTESTACAO', 'AMAZON MARKETPLACE'])(
    'outro crédito no cartão ("%s") é estorno',
    (d) => {
      const m = mapTransaction(tx(d, -5863.63), 'CREDIT');
      expect(m).toEqual({ type: 'refund', amount: '5863.63' });
    },
  );
});

describe('mapTransaction — conta (BANK)', () => {
  it('categoria "Credit card payment" é pagamento de fatura', () => {
    expect(mapTransaction(tx('PAGTO CARTAO', -300, 'Credit card payment'), 'BANK').type).toBe('card_payment');
  });
  it('mesma titularidade é transferência', () => {
    expect(mapTransaction(tx('TED', -300, 'Same person transfer'), 'BANK').type).toBe('transfer');
  });
  it('PIX para Dono Exemplo Silva é transferência entre contas próprias', () => {
    expect(mapTransaction(tx('Pix enviado para Dono Exemplo Silva', -7000, 'Transfer - PIX'), 'BANK', ['dono exemplo silva']).type).toBe('transfer');
    expect(mapTransaction(tx('Pix enviado para Dono Exemplo Silva', -7000, 'Transfer - PIX'), 'BANK').type).toBe('expense'); // sem nomes configurados
  });
  it('investimento automático é investimento', () => {
    expect(mapTransaction(tx('APLICACAO', -100, 'Automatic investment'), 'BANK').type).toBe('investment');
  });
  it('saída é gasto e entrada é receita, com valor sempre positivo', () => {
    expect(mapTransaction(tx('Pix enviado - Fulano', -70, 'Transfer - PIX'), 'BANK')).toEqual({ type: 'expense', amount: '70.00' });
    expect(mapTransaction(tx('Pix recebido - Fulano', 70, 'Transfer - PIX'), 'BANK')).toEqual({ type: 'income', amount: '70.00' });
  });
});
