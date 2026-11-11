/**
 * Mutarea tranzacțiilor (sau a unei poziții întregi) dintr-un portofoliu în altul.
 *
 * Costul, profitul și cash-ul nu se mută „de mână”: se recalculează din
 * tranzacții în ambele portofolii. Înainte de mutare se verifică să nu rămână
 * vânzări fără acoperire (ex.: se mută o cumpărare de care depinde o vânzare
 * rămasă în portofoliul vechi).
 *
 * Cash-ul: o cumpărare mutată nu mai consumă banii portofoliului de unde
 * pleacă. Dacă acolo cash-ul este urmărit (are depuneri), utilizatorul poate
 * cere și mutarea banilor: o retragere din portofoliul vechi și o depunere în
 * cel nou, egale cu efectul tranzacțiilor mutate, la data primei dintre ele.
 */
import type { MoveOptions, MovePreview, MoveResult, Transaction } from '@shared/types';
import { Ledger, sortTransactions, type LedgerTx } from '@shared/calc';
import { dec, toNum, ZERO, type Decimal } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { assert, rowToLedgerTx, rowToTransaction } from './common';
import { getAsset } from './assets';
import { listBrokers } from './brokers';
import { getPortfolio } from './portfolios';
import { createTransaction, ensureValidLedger, ledgerOf } from './transactions';

interface CashEffect {
  portfolioId: number;
  brokerId: number;
  currency: string;
  /** Efectul tranzacțiilor mutate asupra cash-ului portofoliului de unde pleacă (minus = bani consumați). */
  amount: Decimal;
  /** Data primei tranzacții mutate din acest cont. */
  firstDate: string;
}

function loadMoved(db: Db, userId: number, ids: number[]): Transaction[] {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
  assert(unique.length > 0, 'Alege cel puțin o tranzacție.');
  assert(unique.length <= 10_000, 'Prea multe tranzacții deodată.');
  const rows = unique.map((id) => db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, unknown> | undefined);
  assert(rows.every(Boolean), 'Unele tranzacții nu au fost găsite.');
  return (rows as Record<string, unknown>[]).map(rowToTransaction).filter((t) => t.type !== 'split');
}

/** Efectul asupra cash-ului, doar în conturile (portofoliu + broker) unde cash-ul este urmărit. */
function cashEffects(db: Db, userId: number, moved: Transaction[], targetId: number): CashEffect[] {
  const leaving = moved.filter((t) => t.portfolioId !== targetId && t.brokerId != null);
  if (leaving.length === 0) return [];
  const rows = leaving.map((t) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(t.id) as Record<string, unknown>);
  const txs = sortTransactions(rows.map(rowToLedgerTx));
  const currencyOf = (assetId: number): string | undefined => getAsset(db, userId, assetId)?.currency;
  const effect = new Ledger({ method: 'AVG', strict: false, currencyOf }).applyAll(txs).cashBalances();

  // Conturile cu cash urmărit în portofoliile de unde pleacă tranzacțiile.
  const sources = [...new Set(leaving.map((t) => t.portfolioId as number))];
  const tracked = new Set<string>();
  for (const pid of sources) {
    const all = (db.prepare('SELECT * FROM transactions WHERE user_id = ? AND portfolio_id = ?').all(userId, pid) as Record<string, unknown>[]).map(rowToLedgerTx);
    const ledger = new Ledger({ method: 'AVG', strict: false, currencyOf }).applyAll(sortTransactions(all));
    for (const key of ledger.cashTrackedAccounts()) tracked.add(key);
  }
  const firstDate = (pid: number, bid: number): string =>
    txs.filter((t) => t.portfolioId === pid && t.brokerId === bid).reduce((min, t) => (t.date < min ? t.date : min), '9999-12-31');

  return effect
    .filter((c) => c.portfolioId != null && tracked.has(`${c.portfolioId}:${c.brokerId}`) && !c.exact.isZero())
    .map((c) => ({ portfolioId: c.portfolioId as number, brokerId: c.brokerId, currency: c.currency, amount: c.exact, firstDate: firstDate(c.portfolioId as number, c.brokerId) }));
}

export function previewMove(db: Db, userId: number, ids: number[], targetId: number): MovePreview {
  const target = getPortfolio(db, userId, targetId);
  assert(target, 'Portofoliul de destinație nu a fost găsit.');
  const moved = loadMoved(db, userId, ids);
  const brokers = new Map(listBrokers(db, userId).map((b) => [b.id, b.name]));
  const from = [...new Set(moved.filter((t) => t.portfolioId !== targetId).map((t) => t.portfolioId as number))].map(
    (id) => getPortfolio(db, userId, id)?.name ?? '—'
  );
  return {
    count: moved.filter((t) => t.portfolioId !== targetId).length,
    from,
    to: target.name,
    cash: cashEffects(db, userId, moved, targetId).map((c) => ({
      portfolioName: getPortfolio(db, userId, c.portfolioId)?.name ?? '—',
      brokerName: brokers.get(c.brokerId) ?? '—',
      currency: c.currency,
      amount: toNum(c.amount)
    }))
  };
}

/** Mută tranzacțiile în portofoliul dat. Totul sau nimic: dacă istoricul rezultat nu este valid, nu se schimbă nimic. */
export function moveTransactions(db: Db, userId: number, ids: number[], targetId: number, options: MoveOptions): MoveResult {
  const target = getPortfolio(db, userId, targetId);
  assert(target, 'Portofoliul de destinație nu a fost găsit.');
  assert(!target.archived, `Portofoliul „${target.name}” este arhivat. Dezarhivează-l întâi.`);
  const moved = loadMoved(db, userId, ids).filter((t) => t.portfolioId !== targetId);
  if (moved.length === 0) return { moved: 0, cashTransfers: 0 };
  const effects = options?.moveCash ? cashEffects(db, userId, moved, targetId) : [];

  return db.transaction((): MoveResult => {
    const update = db.prepare('UPDATE transactions SET portfolio_id = ? WHERE id = ? AND user_id = ?');
    // Notele din jurnal legate de tranzacțiile mutate se mută odată cu ele.
    const moveJournal = db.prepare('UPDATE journal_entries SET portfolio_id = ? WHERE transaction_id = ? AND user_id = ?');
    for (const t of moved) {
      update.run(targetId, t.id, userId);
      moveJournal.run(targetId, t.id, userId);
    }

    // Istoricul fiecărui activ atins trebuie să rămână coerent în ambele portofolii.
    for (const assetId of new Set(moved.map((t) => t.assetId).filter((id): id is number => id != null))) {
      const asset = getAsset(db, userId, assetId);
      if (asset) ensureValidLedger(db, userId, asset, ledgerOf(db, userId, assetId));
    }

    // Mutarea banilor: retragere din portofoliul vechi + depunere în cel nou (sau invers, la vânzări nete).
    let cashTransfers = 0;
    for (const e of effects) {
      const amount = toNum(e.amount.abs());
      const consumed = e.amount.lt(ZERO); // cumpărări nete: banii pleacă odată cu poziția
      const source = getPortfolio(db, userId, e.portfolioId)?.name ?? '';
      const note = (to: string): string => `Mutare de bani odată cu tranzacțiile mutate (${to})`;
      createTransaction(db, userId, {
        type: consumed ? 'withdrawal' : 'deposit',
        portfolioId: e.portfolioId,
        assetId: null,
        brokerId: e.brokerId,
        currency: e.currency,
        date: e.firstDate,
        amount,
        notes: note(`către ${target.name}`)
      });
      createTransaction(db, userId, {
        type: consumed ? 'deposit' : 'withdrawal',
        portfolioId: targetId,
        assetId: null,
        brokerId: e.brokerId,
        currency: e.currency,
        date: e.firstDate,
        amount,
        notes: note(`din ${source}`)
      });
      cashTransfers++;
    }
    return { moved: moved.length, cashTransfers };
  })();
}

/** Toate tranzacțiile unei poziții (activ + broker) dintr-un portofoliu, pentru mutarea poziției întregi. */
export function positionTransactionIds(db: Db, userId: number, portfolioId: number, assetId: number, brokerId: number): number[] {
  const rows = db
    .prepare("SELECT id FROM transactions WHERE user_id = ? AND portfolio_id = ? AND asset_id = ? AND broker_id = ? AND type <> 'split'")
    .all(userId, portfolioId, assetId, brokerId) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Folosit de teste: soldul de cash al unui cont, exact. */
export function cashOf(txs: LedgerTx[], portfolioId: number, brokerId: number, currency: string): Decimal {
  const c = new Ledger({ method: 'AVG', strict: false }).applyAll(sortTransactions(txs)).cashBalances();
  return c.find((x) => x.portfolioId === portfolioId && x.brokerId === brokerId && x.currency === currency)?.exact ?? dec(0);
}
