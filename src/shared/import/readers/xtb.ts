/**
 * XTB (xStation): raportul de cont exportat în Excel sau CSV. Interpretarea
 * propriu-zisă este în `brokers/xtb.ts`; aici operațiunile devin rânduri de extras.
 *
 * Sumele din coloana „Amount” sunt în moneda contului, prețurile din comentariu
 * în moneda instrumentului. Dividendele vin în moneda contului și se convertesc
 * la import în moneda activului (cu dividendul pe acțiune din comentariu).
 */
import { dec } from '../../calc/decimal';
import { normalizeKey } from '../../csv';
import { mapXtbSymbol, parseXtbReport, XtbParseError, type XtbReport } from '../../brokers/xtb';
import { StatementError, statementRow, type Statement, type StatementReader, type StatementRow, type Table } from '../statement';

const text = (n: number): string => dec(n).toString();

function parse(tables: Table[], fileName: string): XtbReport {
  try {
    return parseXtbReport(tables, fileName);
  } catch (err) {
    if (err instanceof XtbParseError) throw new StatementError(err.message);
    throw err;
  }
}

export const xtbReader: StatementReader = {
  id: 'xtb',
  label: 'XTB (xStation)',

  detect(tables, fileName) {
    const sheets = tables.map((t) => normalizeKey(t.name));
    const namedLikeXtb =
      sheets.some((s) => s.includes('cashoperation')) || /xstation|^[a-z]{3}_\d+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}/i.test(fileName);
    let report: XtbReport;
    try {
      report = parseXtbReport(tables, fileName);
    } catch {
      return false;
    }
    // Comentariile „OPEN BUY … @ …” și „… USD 0.66/ SHR” sunt specifice XTB.
    const xtbComments = report.operations.some((op) => op.kind !== 'dividend' || op.perShare !== null);
    return xtbComments || (namedLikeXtb && report.cash.length > 0);
  },

  read(tables, fileName): Statement {
    const report = parse(tables, fileName);
    const account = report.accountCurrency;
    const rows: StatementRow[] = [];
    for (const op of report.operations) {
      const base = {
        line: op.row,
        date: op.date,
        time: op.time,
        symbol: op.symbol,
        name: op.name || null,
        guess: { ...mapXtbSymbol(op.symbol), type: op.category },
        externalId: `xtb:${op.id}`,
        cashCurrency: account
      };
      if (op.kind === 'dividend') {
        rows.push(
          statementRow({
            ...base,
            kind: 'dividend',
            currency: account,
            amount: text(op.amount),
            tax: text(op.tax),
            perShare: op.perShare === null ? null : text(op.perShare),
            perShareCurrency: op.perShareCurrency,
            cashAmount: dec(op.amount).minus(op.tax).toString()
          })
        );
      } else {
        rows.push(
          statementRow({
            ...base,
            kind: op.kind,
            quantity: text(op.quantity),
            price: text(op.price),
            // Suma debitată/creditată efectiv, în moneda contului (include conversia valutară XTB).
            cashAmount: op.amount === null ? null : text(op.kind === 'buy' ? -op.amount : op.amount)
          })
        );
      }
    }
    for (const op of report.cash) {
      rows.push(
        statementRow({
          line: op.row,
          kind: op.kind,
          date: op.date,
          time: op.time,
          currency: account,
          amount: text(op.amount),
          externalId: `xtb:${op.id}`,
          note: op.symbol ? `${op.label} ${op.symbol}` : op.label
        })
      );
    }
    return {
      format: 'xtb',
      formatLabel: this.label,
      brokerName: 'XTB',
      accountCurrency: account,
      rows,
      problems: [],
      ignored: report.ignored.map(({ label, count }) => ({ label, count })),
      warnings: [],
      openPositions: report.openPositions
    };
  }
};
