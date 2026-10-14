import { logger } from '../core/logger.js';

const BASE = 'https://api.pluggy.ai';

export interface PluggyAccount {
  id: string;
  itemId: string;
  type: 'BANK' | 'CREDIT';
  subtype: string | null;
  name: string;
  marketingName: string | null;
  number: string | null;
  balance: number;
  currencyCode: string;
  creditData?: {
    brand: string | null;
    level: string | null;
    balanceCloseDate: string | null;
    balanceDueDate: string | null;
    availableCreditLimit: number | null;
    creditLimit: number | null;
  } | null;
}

export interface PluggyTransaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  currencyCode: string;
  category: string | null;
  status: string;
  merchant?: { name?: string; businessName?: string } | null;
  paymentData?: unknown;
  creditCardMetadata?: {
    installmentNumber?: number;
    totalInstallments?: number;
    totalAmount?: number;
    purchaseDate?: string;
  } | null;
}

export class PluggyClient {
  private apiKey: string | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async auth(): Promise<string> {
    const res = await fetch(`${BASE}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
    });
    if (!res.ok) throw new Error(`Pluggy auth falhou: HTTP ${res.status}`);
    const body = (await res.json()) as { apiKey: string };
    this.apiKey = body.apiKey;
    return this.apiKey;
  }

  private async request<T>(path: string, retry = true): Promise<T> {
    const key = this.apiKey ?? (await this.auth());
    const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-KEY': key } });
    if ((res.status === 401 || res.status === 403) && retry) {
      this.apiKey = null;
      return this.request<T>(path, false);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Pluggy GET ${path} falhou: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async fetchAccounts(itemId: string): Promise<PluggyAccount[]> {
    const body = await this.request<{ results: PluggyAccount[] }>(`/accounts?itemId=${itemId}`);
    return body.results;
  }

  /** Percorre todas as páginas do /v2/transactions (cursor). */
  async fetchAllTransactions(accountId: string): Promise<PluggyTransaction[]> {
    const all: PluggyTransaction[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor
        ? `accountId=${accountId}&cursor=${encodeURIComponent(cursor)}`
        : `accountId=${accountId}`;
      const body = await this.request<{ results: PluggyTransaction[]; nextCursor: string | null }>(
        `/v2/transactions?${qs}`,
      );
      all.push(...body.results);
      cursor = body.nextCursor;
    } while (cursor);
    logger.info({ accountId, count: all.length }, 'transações buscadas do Pluggy');
    return all;
  }
}
