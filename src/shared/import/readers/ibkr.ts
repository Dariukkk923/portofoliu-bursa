/**
 * Interactive Brokers: raportul „Activity Statement” exportat în CSV.
 *
 * Fișierul are mai multe secțiuni, fiecare cu antetul propriu; primele două
 * coloane sunt numele secțiunii și felul rândului („Header”, „Data”, „Total”):
 *   Statement,Header,Field Name,Field Value
 *   Account Information,Data,Base Currency,EUR
 *   Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,…
 *   Dividends,Header,Currency,Date,Description,Amount
 *   Withholding Tax,Header,Currency,Date,Description,Amount,Code
 *   Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount
 *   Fees,Header,Subtitle,Currency,Date,Description,Amount
 *   Interest,Header,Currency,Date,Description,Amount
 *   Corporate Actions,Header,Asset Category,Currency,Report Date,Date/Time,Description,Quantity,…
 *   Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,…
 *   Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Security ID,…,Listing Exch,…
 * Se importă doar acțiunile și ETF-urile („Stocks”); opțiunile, contractele futures și
 * conversiile valutare („Forex”) se numără și se ignoră.
 */
import { dec } from '../../calc/decimal';
import { IgnoredCounter, statementRow, type Cell, type Statement, type StatementReader, type StatementRow, type Table } from '../statement';
import { headerKey } from '../table';
import { cellText, cleanCurrency, findIsin, ibkrSymbol, parseDecimal, parseWhen } from '../values';

type Record_ = Record<string, Cell>;

interface Sections {
  rows: Map<string, { line: number; data: Record_ }[]>;
}

const isIbkr = (rows: Cell[][]): boolean =>
  rows.slice(0, 40).some((r) => cellText(r[0]) === 'Statement' && cellText(r[1]) === 'Header') ||
  rows.filter((r) => cellText(r[1]) === 'Header' && ['Trades', 'Dividends', 'Deposits & Withdrawals', 'Open Positions'].includes(cellText(r[0]))).length >= 2;

/** Grupează rândurile „Data” pe secțiune, cu antetul curent al secțiunii (o secțiune poate avea mai multe antete). */
function readSections(rows: Cell[][]): Sections {
  const headers = new Map<string, string[]>();
  const out: Sections = { rows: new Map() };
  rows.forEach((row, i) => {
    const section = cellText(row[0]);
    const kind = cellText(row[1]);
    if (!section) return;
    if (kind === 'Header') {
      headers.set(section, row.slice(2).map(headerKey));
      return;
    }
    if (kind !== 'Data') return;
    const header = headers.get(section);
    if (!header) return;
    const data: Record_ = {};
    header.forEach((key, c) => (data[key] = row[c + 2] ?? null));
    out.rows.set(section, [...(out.rows.get(section) ?? []), { line: i + 1, data }]);
  });
  return out;
}

/** „AAPL(US0378331005) Cash Dividend USD 0.24 per Share (Ordinary Dividend)” -> simbol, ISIN, dividend pe acțiune. */
function describe(description: string): { symbol: string; isin: string | null; perShare: string | null; perShareCurrency: string | null } {
  const symbol = description.split(/[\s(]/)[0].trim().toUpperCase();
  const m = description.match(/\b([A-Z]{3})\s+([0-9]+(?:\.[0-9]+)?)\s+per\s+Share/i);
  return { symbol, isin: findIsin(description), perShare: m ? m[2] : null, perShareCurrency: m ? m[1].toUpperCase() : null };
}

export const ibkrReader: StatementReader = {
  id: 'ibkr',
  label: 'Interactive Brokers',

  detect(tables) {
    return tables.some((t) => isIbkr(t.rows));
  },

  read(tables: Table[]): Statement {
    const table = tables.find((t) => isIbkr(t.rows));
    if (!table) throw new Error('Nu este un raport Interactive Brokers.');
    const { rows: sections } = readSections(table.rows);
    const get = (name: string) => sections.get(name) ?? [];
    const num = (cell: Cell | undefined): string | null => parseDecimal(cell ?? null);
    const text = (cell: Cell | undefined): string => cellText(cell ?? null);

    const rows: StatementRow[] = [];
    const problems: Statement['problems'] = [];
    const ignored = new IgnoredCounter();

    // Moneda contului și datele instrumentelor (ISIN, bursa, denumirea).
    let account: string | null = null;
    for (const { data } of get('Account Information')) {
      if (text(data.fieldname) === 'Base Currency') account = cleanCurrency(data.fieldvalue);
    }
    const instruments = new Map<string, { isin: string | null; name: string | null; exchange: string | null }>();
    for (const { data } of get('Financial Instrument Information')) {
      if (text(data.assetcategory) !== 'Stocks') continue;
      for (const symbol of text(data.symbol).split(',').map((s) => s.trim().toUpperCase())) {
        if (!symbol) continue;
        instruments.set(symbol, {
          isin: findIsin(text(data.securityid)),
          name: text(data.description) || null,
          exchange: text(data.listingexch) || null
        });
      }
    }
    const instrument = (symbol: string, currency: string | null) => {
      const info = instruments.get(symbol);
      return { symbol, isin: info?.isin ?? null, name: info?.name ?? null, guess: ibkrSymbol(symbol, info?.exchange ?? null, currency) };
    };

    // Cumpărări și vânzări (rândurile „Order”; cantitatea negativă = vânzare).
    let forex = false;
    for (const { line, data } of get('Trades')) {
      const discriminator = text(data.datadiscriminator);
      if (discriminator && discriminator !== 'Order') continue;
      const category = text(data.assetcategory);
      if (category !== 'Stocks') {
        ignored.add(category || 'Trades');
        if (category === 'Forex') forex = true;
        continue;
      }
      const when = parseWhen(data['date/time'], 'ymd');
      const quantity = num(data.quantity);
      const price = num(data['t.price']);
      const currency = cleanCurrency(data.currency);
      const symbol = text(data.symbol).toUpperCase();
      if (!when || quantity === null || price === null || dec(quantity).isZero() || !symbol) {
        problems.push({ line, message: `Tranzacția ${symbol || ''} nu poate fi citită (dată, cantitate sau preț lipsă).` });
        continue;
      }
      const proceeds = num(data.proceeds);
      const commission = num(data['comm/fee']);
      const fee = commission === null ? null : dec(commission).abs().toString();
      rows.push(
        statementRow({
          line,
          kind: dec(quantity).gt(0) ? 'buy' : 'sell',
          ...when,
          ...instrument(symbol, currency),
          quantity: dec(quantity).abs().toString(),
          price,
          currency,
          fee: fee === '0' ? null : fee,
          // Suma mișcată în cont: încasări (cu minus la cumpărare) + comision (negativ).
          cashAmount: proceeds === null ? null : dec(proceeds).plus(commission ?? 0).toString(),
          cashCurrency: currency
        })
      );
    }

    // Dividende (sumele negative sunt corecții și se adună cu dividendul din aceeași zi).
    for (const { line, data } of get('Dividends')) {
      const currency = cleanCurrency(data.currency);
      const when = parseWhen(data.date, 'ymd');
      const amount = num(data.amount);
      if (!currency || !when || amount === null) continue; // rândurile „Total”
      const d = describe(text(data.description));
      rows.push(
        statementRow({
          line,
          kind: 'dividend',
          ...when,
          ...instrument(d.symbol, currency),
          isin: d.isin ?? instruments.get(d.symbol)?.isin ?? null,
          currency,
          amount,
          perShare: d.perShare,
          perShareCurrency: d.perShareCurrency,
          cashAmount: amount,
          cashCurrency: currency,
          note: text(data.description) || null
        })
      );
    }

    // Impozitul reținut la sursă: negativ = reținut, pozitiv = returnat.
    for (const { line, data } of get('Withholding Tax')) {
      const currency = cleanCurrency(data.currency);
      const when = parseWhen(data.date, 'ymd');
      const amount = num(data.amount);
      if (!currency || !when || amount === null) continue;
      const d = describe(text(data.description));
      rows.push(statementRow({ line, kind: 'tax', ...when, ...instrument(d.symbol, currency), isin: d.isin, currency, amount: dec(amount).neg().toString() }));
    }

    for (const { line, data } of get('Deposits & Withdrawals')) {
      const currency = cleanCurrency(data.currency);
      const when = parseWhen(data.settledate ?? data.date, 'ymd');
      const amount = num(data.amount);
      if (!currency || !when || amount === null || dec(amount).isZero()) continue;
      rows.push(
        statementRow({ line, kind: dec(amount).gt(0) ? 'deposit' : 'withdrawal', ...when, currency, amount: dec(amount).abs().toString(), note: text(data.description) || null })
      );
    }

    for (const { line, data } of get('Fees')) {
      const currency = cleanCurrency(data.currency);
      const when = parseWhen(data.date, 'ymd');
      const amount = num(data.amount);
      if (!currency || !when || amount === null || dec(amount).isZero()) continue;
      if (dec(amount).gt(0)) {
        ignored.add('Comision returnat');
        continue;
      }
      rows.push(statementRow({ line, kind: 'fee', ...when, currency, amount: dec(amount).abs().toString(), note: text(data.description) || null }));
    }

    for (const { line, data } of get('Interest')) {
      const currency = cleanCurrency(data.currency);
      const when = parseWhen(data.date, 'ymd');
      const amount = num(data.amount);
      if (!currency || !when || amount === null || dec(amount).isZero()) continue;
      // Dobânda plătită (pe marjă) este un cost.
      rows.push(
        statementRow({ line, kind: dec(amount).gt(0) ? 'interest' : 'fee', ...when, currency, amount: dec(amount).abs().toString(), note: text(data.description) || null })
      );
    }

    // Split-uri: „AAPL(US0378331005) Split 4 for 1 (…)”.
    const splits = new Set<string>();
    for (const { line, data } of get('Corporate Actions')) {
      const description = text(data.description);
      const m = description.match(/Split\s+([0-9.]+)\s+for\s+([0-9.]+)/i);
      if (!m) {
        if (description) ignored.add('Eveniment corporativ');
        continue;
      }
      const when = parseWhen(data['date/time'] ?? data.reportdate, 'ymd');
      const d = describe(description);
      const key = `${d.symbol}|${when?.date}|${m[1]}:${m[2]}`;
      if (!when || splits.has(key)) continue;
      splits.add(key);
      rows.push(statementRow({ line, kind: 'split', ...when, ...instrument(d.symbol, cleanCurrency(data.currency)), isin: d.isin, ratio: `${m[1]}:${m[2]}` }));
    }

    // Pozițiile raportate, pentru verificare.
    const open: Record<string, number> = {};
    for (const { data } of get('Open Positions')) {
      if (text(data.assetcategory) !== 'Stocks' || (text(data.datadiscriminator) && text(data.datadiscriminator) !== 'Summary')) continue;
      const q = num(data.quantity);
      const symbol = text(data.symbol).toUpperCase();
      if (q !== null && symbol) open[symbol] = (open[symbol] ?? 0) + Number(q);
    }

    return {
      format: 'ibkr',
      formatLabel: this.label,
      brokerName: 'Interactive Brokers',
      accountCurrency: account,
      rows,
      problems,
      ignored: ignored.list(),
      warnings: forex
        ? ['Schimburile valutare (Forex) nu se importă: cash-ul se urmărește separat pe fiecare monedă, așa că o monedă poate apărea pe minus. Corectează soldurile din Panou → Cash disponibil.']
        : [],
      openPositions: Object.keys(open).length > 0 ? open : null
    };
  }
};
