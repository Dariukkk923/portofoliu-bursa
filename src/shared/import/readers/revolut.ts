/**
 * Revolut (Stocks): extrasul de cont exportat în CSV („Account statement”, nu
 * „Profit and loss”).
 *
 * Antet: Date, Ticker, Type, Quantity, Price per share, Total Amount, Currency, FX Rate.
 * Sumele pot avea moneda în față („USD 150.25”, „$150.25”). Tipurile:
 * „BUY - MARKET”, „SELL - LIMIT”, „DIVIDEND”, „CASH TOP-UP”, „CASH WITHDRAWAL”,
 * „CUSTODY FEE”, „STOCK SPLIT” (cantitatea = acțiunile primite), „DIVIDEND TAX (CORRECTION)”.
 * Suma totală include comisioanele; transferurile între entitățile Revolut se ignoră.
 */
import { dec } from '../../calc/decimal';
import { normalizeKey } from '../../csv';
import { IgnoredCounter, statementRow, type Statement, type StatementKind, type StatementReader, type StatementRow, type Table } from '../statement';
import { Columns, findTable } from '../table';
import { cellText, classifyKind, cleanCurrency, detectDateOrder, detectDecimalComma, guessSymbol, parseDecimal, parseWhen } from '../values';

const REQUIRED = ['ticker', 'type', 'quantity', 'pricepershare', 'totalamount'];

function kindOf(type: string): StatementKind | null {
  const key = normalizeKey(type);
  if (key.startsWith('transfer')) return null;
  if (key.includes('dividendtax')) return 'tax';
  if (key.startsWith('buy')) return 'buy';
  if (key.startsWith('sell')) return 'sell';
  if (key === 'cashtopup') return 'deposit';
  if (key === 'cashwithdrawal') return 'withdrawal';
  if (key.includes('stocksplit')) return 'split';
  return classifyKind(type);
}

export const revolutReader: StatementReader = {
  id: 'revolut',
  label: 'Revolut',

  detect(tables) {
    return findTable(tables, REQUIRED) !== null;
  },

  read(tables: Table[]): Statement {
    const found = findTable(tables, REQUIRED);
    if (!found) throw new Error('Nu este un extras Revolut.');
    const { table, header } = found;
    const c = new Columns(table.rows[header]);
    const col = {
      date: c.find('date', 'data'),
      ticker: c.find('ticker'),
      type: c.find('type'),
      quantity: c.find('quantity'),
      price: c.find('pricepershare'),
      total: c.find('totalamount'),
      currency: c.find('currency')
    };
    const data = table.rows.slice(header + 1);
    const decimalComma = detectDecimalComma(data.flatMap((r) => [c.cell(r, col.quantity), c.cell(r, col.price), c.cell(r, col.total)]));
    const { order } = detectDateOrder(data.map((r) => c.cell(r, col.date)));
    const num = (row: (typeof data)[number], index: number): string | null => parseDecimal(c.cell(row, index), decimalComma);

    const rows: StatementRow[] = [];
    const problems: Statement['problems'] = [];
    const ignored = new IgnoredCounter();
    const currencies = new Set<string>();

    data.forEach((row, i) => {
      const line = header + i + 2;
      const type = c.text(row, col.type);
      if (!type) return;
      const kind = kindOf(type);
      if (!kind || kind === 'coupon') return ignored.add(type);
      const when = parseWhen(c.cell(row, col.date), order);
      if (!when) return void problems.push({ line, message: `Data „${c.text(row, col.date)}” nu poate fi citită.` });
      // Moneda: din coloana „Currency” sau din prefixul sumei („USD 150.25”).
      const currency = cleanCurrency(c.cell(row, col.currency)) ?? cleanCurrency(cellText(c.cell(row, col.total)).slice(0, 3));
      if (currency) currencies.add(currency);
      const total = num(row, col.total);
      const ticker = c.text(row, col.ticker).toUpperCase();

      if (kind === 'deposit' || kind === 'withdrawal' || (kind === 'fee' && !ticker) || kind === 'interest') {
        if (total === null || dec(total).isZero()) return void problems.push({ line, message: `Lipsește suma operațiunii „${type}”.` });
        rows.push(statementRow({ line, kind, ...when, currency, amount: dec(total).abs().toString(), note: type }));
        return;
      }
      if (!ticker) return void problems.push({ line, message: `Lipsește simbolul operațiunii „${type}”.` });
      const base = { line, ...when, symbol: ticker, guess: guessSymbol(ticker, { currency }), currency, note: type };

      switch (kind) {
        case 'buy':
        case 'sell': {
          const quantity = num(row, col.quantity);
          const price = num(row, col.price);
          if (quantity === null || !dec(quantity).abs().gt(0) || price === null) {
            return void problems.push({ line, message: `Cantitatea sau prețul lipsesc pentru „${type}” ${ticker}.` });
          }
          const cash = total === null ? null : dec(total).abs();
          rows.push(
            statementRow({
              ...base,
              kind,
              quantity: dec(quantity).abs().toString(),
              price: dec(price).abs().toString(),
              cashAmount: cash === null ? null : (kind === 'buy' ? cash.neg() : cash).toString(),
              cashCurrency: currency
            })
          );
          return;
        }
        case 'dividend':
          if (total === null) return void problems.push({ line, message: `Lipsește suma dividendului ${ticker}.` });
          rows.push(statementRow({ ...base, kind, amount: dec(total).toString(), cashAmount: dec(total).toString(), cashCurrency: currency }));
          return;
        case 'tax':
          // Suma negativă = impozit reținut în plus; pozitivă = impozit returnat.
          if (total === null) return void problems.push({ line, message: `Lipsește suma impozitului ${ticker}.` });
          rows.push(statementRow({ ...base, kind, amount: dec(total).neg().toString() }));
          return;
        case 'split': {
          const quantity = num(row, col.quantity);
          if (quantity === null || dec(quantity).isZero()) return void problems.push({ line, message: `Split fără cantitate pentru ${ticker}.` });
          rows.push(statementRow({ ...base, kind, quantity }));
          return;
        }
        case 'fee':
          if (total === null || dec(total).isZero()) return void problems.push({ line, message: `Lipsește suma comisionului ${ticker}.` });
          rows.push(statementRow({ ...base, kind, amount: dec(total).abs().toString() }));
          return;
        default:
          ignored.add(type);
      }
    });

    return {
      format: 'revolut',
      formatLabel: this.label,
      brokerName: 'Revolut',
      accountCurrency: currencies.size === 1 ? [...currencies][0] : null,
      rows,
      problems,
      ignored: ignored.list(),
      warnings: [],
      openPositions: null
    };
  }
};
