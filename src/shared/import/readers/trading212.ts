/**
 * Trading 212: exportul CSV din History -> Export (cel mult un an pe fișier).
 *
 * Antet (variantele recente; ordinea și unele coloane diferă între versiuni):
 *   Action, Time, ISIN, Ticker, Name, No. of shares, Price / share,
 *   Currency (Price / share), Exchange rate, Result, Currency (Result), Total,
 *   Currency (Total), Withholding tax, Currency (Withholding tax), Notes, ID,
 *   Currency conversion fee, Currency (Currency conversion fee), …
 * Exporturile mai vechi au moneda în denumire: „Total (EUR)”, „Result (EUR)”.
 *
 * - „Market buy”, „Limit sell”…: cantitatea și prețul în moneda instrumentului
 *   (GBX = pence pentru Londra), „Total” = suma din cont, în moneda contului.
 * - „Dividend (…)”: „No. of shares” = acțiunile deținute, „Price / share” =
 *   dividendul NET pe acțiune; brutul = net + impozitul reținut.
 * - „Deposit”, „Withdrawal”, „Interest on cash”: sume în moneda contului.
 * - „Currency conversion” și restul se numără și se ignoră.
 */
import { dec, ZERO, type Decimal } from '../../calc/decimal';
import { IgnoredCounter, statementRow, type Statement, type StatementKind, type StatementReader, type StatementRow, type Table } from '../statement';
import { Columns, findTable } from '../table';
import { cleanCurrency, detectDecimalComma, guessSymbol, isIsin, parseDecimal, parseWhen } from '../values';

const REQUIRED = ['action', 'time', 'no.ofshares'];

function kindOf(action: string): StatementKind | null {
  const a = action.toLowerCase();
  if (a.includes('split')) return 'split';
  if (a.includes('buy')) return 'buy';
  if (a.includes('sell')) return 'sell';
  if (a.includes('dividend')) return 'dividend';
  if (a.includes('deposit')) return 'deposit';
  if (a.includes('withdraw')) return 'withdrawal';
  if (a.includes('interest')) return 'interest';
  return null;
}

/** Moneda dintr-o denumire de coloană de forma „total(eur)”. */
const currencyInKey = (key: string): string | null => {
  const m = key.match(/\(([a-z]{3})\)$/);
  return m ? m[1].toUpperCase() : null;
};

export const trading212Reader: StatementReader = {
  id: 'trading212',
  label: 'Trading 212',

  detect(tables) {
    return findTable(tables, REQUIRED) !== null;
  },

  read(tables: Table[]): Statement {
    const found = findTable(tables, REQUIRED);
    if (!found) throw new Error('Nu este un export Trading 212.');
    const { table, header } = found;
    const c = new Columns(table.rows[header]);
    const col = {
      action: c.find('action'),
      time: c.find('time'),
      isin: c.find('isin'),
      ticker: c.find('ticker'),
      name: c.find('name'),
      shares: c.find('no.ofshares'),
      price: c.find('price/share'),
      priceCurrency: c.find('currency(price/share)'),
      fx: c.find('exchangerate'),
      total: c.find('total') >= 0 ? c.find('total') : c.startsWith('total('),
      totalCurrency: c.find('currency(total)'),
      wht: c.find('withholdingtax') >= 0 ? c.find('withholdingtax') : c.startsWith('withholdingtax('),
      whtCurrency: c.find('currency(withholdingtax)'),
      notes: c.find('notes'),
      id: c.find('id')
    };
    const totalKey = col.total >= 0 ? c.keys[col.total] : '';
    // Comisioanele: conversie valutară, stamp duty, taxe de tranzacție (fiecare cu moneda ei).
    const feeColumns = c.keys
      .map((key, index) => ({ key, index }))
      .filter(({ key }) => !key.startsWith('currency(') && /(fee|stampduty|transactiontax|chargeamount)/.test(key))
      .map(({ key, index }) => ({ index, currency: currencyInKey(key), currencyCol: c.find(`currency(${key})`) }));

    const data = table.rows.slice(header + 1);
    const numeric = [col.shares, col.price, col.total, col.wht, col.fx, ...feeColumns.map((f) => f.index)];
    const decimalComma = detectDecimalComma(data.flatMap((r) => numeric.map((i) => c.cell(r, i))));
    const num = (row: (typeof data)[number], index: number): string | null => parseDecimal(c.cell(row, index), decimalComma);

    const rows: StatementRow[] = [];
    const problems: Statement['problems'] = [];
    const ignored = new IgnoredCounter();
    let account: string | null = currencyInKey(totalKey);

    data.forEach((row, i) => {
      const line = header + i + 2;
      const action = c.text(row, col.action);
      if (!action) return;
      const kind = kindOf(action);
      if (!kind || kind === 'split') return ignored.add(action);
      const when = parseWhen(c.cell(row, col.time), 'ymd');
      if (!when) return void problems.push({ line, message: `Data „${c.text(row, col.time)}” nu poate fi citită.` });

      const totalCurrency = cleanCurrency(c.cell(row, col.totalCurrency)) ?? currencyInKey(totalKey);
      account ??= totalCurrency;
      const total = num(row, col.total);
      const externalId = c.text(row, col.id) ? `t212:${c.text(row, col.id)}` : null;
      const note = c.text(row, col.notes) || null;

      if (kind === 'deposit' || kind === 'withdrawal' || kind === 'interest') {
        if (total === null || dec(total).isZero()) return void problems.push({ line, message: `Lipsește suma operațiunii „${action}”.` });
        rows.push(statementRow({ line, kind, ...when, currency: totalCurrency, amount: dec(total).abs().toString(), externalId, note: note ?? action }));
        return;
      }

      const isin = isIsin(c.text(row, col.isin)) ? c.text(row, col.isin).toUpperCase() : null;
      const ticker = c.text(row, col.ticker).toUpperCase();
      const symbol = ticker || isin;
      if (!symbol) return void problems.push({ line, message: `Lipsește instrumentul operațiunii „${action}”.` });
      const priceCurrency = cleanCurrency(c.cell(row, col.priceCurrency));
      const shares = num(row, col.shares);
      const price = num(row, col.price);
      if (shares === null || price === null || !dec(shares).gt(0)) {
        return void problems.push({ line, message: `Cantitatea sau prețul lipsesc pentru „${action}” ${symbol}.` });
      }
      const fx = num(row, col.fx);
      const base = {
        line,
        ...when,
        symbol,
        isin,
        name: c.text(row, col.name) || null,
        guess: ticker ? guessSymbol(ticker, { currency: priceCurrency, isin }) : null,
        externalId,
        note
      };

      if (kind === 'dividend') {
        const net = dec(shares).times(price);
        const whtText = num(row, col.wht);
        let wht: Decimal = whtText === null ? ZERO : dec(whtText).abs();
        const whtCurrency = cleanCurrency(c.cell(row, col.whtCurrency)) ?? priceCurrency;
        // Impozitul în altă monedă decât dividendul (rar): convertit cu cursul din rând.
        if (!wht.isZero() && whtCurrency !== priceCurrency && fx !== null && whtCurrency === totalCurrency) wht = wht.times(fx);
        rows.push(
          statementRow({
            ...base,
            kind: 'dividend',
            currency: priceCurrency,
            amount: net.plus(wht).toString(),
            tax: wht.toString(),
            perShare: price,
            perShareCurrency: priceCurrency,
            cashAmount: total === null ? null : dec(total).abs().toString(),
            cashCurrency: totalCurrency
          })
        );
        return;
      }

      // Cumpărare sau vânzare. Comisioanele sunt de regulă în moneda contului: se trec în moneda prețului.
      const value = dec(shares).times(price);
      const rate = fx !== null && dec(fx).gt(0) ? dec(fx) : total !== null && !dec(total).isZero() ? value.div(dec(total).abs()) : null;
      let fee = ZERO;
      for (const f of feeColumns) {
        const amount = num(row, f.index);
        if (amount === null || dec(amount).isZero()) continue;
        const currency = cleanCurrency(c.cell(row, f.currencyCol)) ?? f.currency ?? totalCurrency;
        const abs = dec(amount).abs();
        fee = fee.plus(currency === priceCurrency || !rate ? abs : abs.times(rate));
      }
      rows.push(
        statementRow({
          ...base,
          kind,
          quantity: shares,
          price,
          currency: priceCurrency,
          fee: fee.isZero() ? null : fee.toDecimalPlaces(8).toString(),
          cashAmount: total === null ? null : (kind === 'buy' ? dec(total).abs().neg() : dec(total).abs()).toString(),
          cashCurrency: totalCurrency
        })
      );
    });

    return {
      format: 'trading212',
      formatLabel: this.label,
      brokerName: 'Trading 212',
      accountCurrency: account,
      rows,
      problems,
      ignored: ignored.list(),
      warnings: [],
      openPositions: null
    };
  }
};
