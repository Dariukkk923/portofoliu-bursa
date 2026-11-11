/**
 * Raportul anual pentru taxe: pe broker și pe monedă, câștigurile și pierderile din vânzări,
 * dividendele/cupoanele/dobânzile (brut, impozit reținut, net) și comisioanele, cu echivalentul
 * în lei la cursul din ziua fiecărei tranzacții. Implicit toate portofoliile. Export PDF și CSV.
 * Aplicația nu calculează impozitul de plată.
 */
import { useState, type ReactNode } from 'react';
import { FileDown, FileText } from 'lucide-react';
import type { FxSource, TaxGroupTotals, TaxReport, TaxSection } from '@shared/types';
import { TRANSACTION_TYPE_LABEL } from '@shared/labels';
import { FX_SOURCE_LABEL, RESIDENCE_HINT, RESIDENCE_SECTION_LABEL, TAX_DISCLAIMER } from '@shared/tax';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, quantity as fmtQty } from '../lib/format';
import { Button, Card, EmptyState, LoadError, Notice, PageSkeleton, Select, TD, TH, cx } from '../components/ui';

const DETAIL_PAGE = 60;

/** Suma în moneda ei și, dedesubt, echivalentul în lei (dacă moneda nu e leul). */
function Amount({ value, ron, currency, strong, tone }: { value: number; ron: number; currency: string; strong?: boolean; tone?: boolean }) {
  const cls = tone ? (value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : 'text-ink') : 'text-ink';
  return (
    <span className="block text-right">
      <span className={cx('tabular', strong && 'font-semibold', cls)}>{money(value, currency)}</span>
      {currency !== 'RON' && <span className="tabular block text-xs text-ink-3">{money(ron, 'RON')}</span>}
    </span>
  );
}

function Total({ label, value, tone }: { label: string; value: number; tone?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <p className="text-xs text-ink-2">{label}</p>
      <p className={cx('tabular text-md font-semibold', tone ? (value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : 'text-ink') : 'text-ink')}>{money(value, 'RON')}</p>
    </div>
  );
}

const incomeRows = (g: TaxGroupTotals): { label: string; m: TaxGroupTotals['dividends'] }[] =>
  [
    { label: 'Dividende', m: g.dividends },
    { label: 'Cupoane', m: g.coupons },
    { label: 'Dobânzi', m: g.interest }
  ].filter((r) => r.m.gross !== 0 || r.m.tax !== 0 || r.m.net !== 0);

function SectionCard({ section }: { section: TaxSection }) {
  const sales = section.groups.filter((g) => g.sales > 0);
  const income = section.groups.flatMap((g) => incomeRows(g).map((r) => ({ g, ...r })));
  const fees = section.groups.filter((g) => g.fees > 0);
  const t = section.totalRon;
  return (
    <Card title={RESIDENCE_SECTION_LABEL[section.residence]} padded={false}>
      <p className="px-4 pb-3 text-xs text-ink-2">{RESIDENCE_HINT[section.residence]}</p>

      {sales.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-y border-line">
                <th className={TH}>Câștiguri și pierderi din vânzări</th>
                <th className={cx(TH, 'text-right')}>Vânzări</th>
                <th className={cx(TH, 'text-right')}>Încasări</th>
                <th className={cx(TH, 'text-right')}>Cost</th>
                <th className={cx(TH, 'text-right')}>Câștiguri</th>
                <th className={cx(TH, 'text-right')}>Pierderi</th>
                <th className={cx(TH, 'text-right')}>Rezultat net</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((g) => (
                <tr key={`${g.brokerId}:${g.currency}`} className="border-b border-line align-top">
                  <td className={cx(TD, 'font-semibold')}>
                    {g.brokerName} <span className="font-normal text-ink-3">· {g.currency}</span>
                  </td>
                  <td className={cx(TD, 'tabular text-right')}>{g.sales}</td>
                  <td className={TD}>
                    <Amount value={g.proceeds} ron={g.proceedsRon} currency={g.currency} />
                  </td>
                  <td className={TD}>
                    <Amount value={g.cost} ron={g.costRon} currency={g.currency} />
                  </td>
                  <td className={TD}>
                    <Amount value={g.gains} ron={g.gainsRon} currency={g.currency} />
                  </td>
                  <td className={TD}>
                    <Amount value={g.losses} ron={g.lossesRon} currency={g.currency} />
                  </td>
                  <td className={TD}>
                    <Amount value={g.net} ron={g.netRon} currency={g.currency} strong tone />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {income.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-y border-line">
                <th className={TH}>Dividende, cupoane și dobânzi</th>
                <th className={TH}>Tip</th>
                <th className={cx(TH, 'text-right')}>Brut</th>
                <th className={cx(TH, 'text-right')}>Impozit reținut</th>
                <th className={cx(TH, 'text-right')}>Net</th>
              </tr>
            </thead>
            <tbody>
              {income.map(({ g, label, m }) => (
                <tr key={`${g.brokerId}:${g.currency}:${label}`} className="border-b border-line align-top">
                  <td className={cx(TD, 'font-semibold')}>
                    {g.brokerName} <span className="font-normal text-ink-3">· {g.currency}</span>
                  </td>
                  <td className={cx(TD, 'text-ink-2')}>{label}</td>
                  <td className={TD}>
                    <Amount value={m.gross} ron={m.grossRon} currency={g.currency} />
                  </td>
                  <td className={TD}>
                    <Amount value={m.tax} ron={m.taxRon} currency={g.currency} />
                  </td>
                  <td className={TD}>
                    <Amount value={m.net} ron={m.netRon} currency={g.currency} strong />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fees.length > 0 && (
        <p className="px-4 pt-3 text-xs text-ink-2">
          Comisioane plătite:{' '}
          {fees.map((g, i) => (
            <span key={`${g.brokerId}:${g.currency}`}>
              {i > 0 && ' · '}
              {g.brokerName} <span className="tabular font-medium text-ink">{money(g.fees, g.currency)}</span>
              {g.currency !== 'RON' && <span className="tabular text-ink-3"> ({money(g.feesRon, 'RON')})</span>}
            </span>
          ))}
          . Cele de la cumpărări și vânzări sunt deja incluse în cost și în încasări.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 p-4 md:grid-cols-4">
        <Total label="Rezultat net din vânzări" value={t.net} tone />
        <Total label="Dividende brute" value={t.dividendsGross} />
        <Total label="Impozit reținut pe dividende" value={t.dividendsTax} />
        <Total label="Comisioane" value={t.fees} />
        {(t.couponsGross !== 0 || t.interestGross !== 0) && (
          <>
            <Total label="Cupoane brute" value={t.couponsGross} />
            <Total label="Dobânzi brute" value={t.interestGross} />
            <Total label="Impozit reținut (cupoane și dobânzi)" value={t.couponsTax + t.interestTax} />
          </>
        )}
      </div>
    </Card>
  );
}

function Details({ report }: { report: TaxReport }) {
  const [all, setAll] = useState(false);
  const rows = all ? report.details : report.details.slice(0, DETAIL_PAGE);
  const value = (d: TaxReport['details'][number]): ReactNode =>
    d.type === 'sell' ? money(d.proceeds ?? 0, d.currency) : d.gross !== null ? money(d.gross, d.currency) : money(d.fee, d.currency);
  const result = (d: TaxReport['details'][number]): { v: number; ron: number | null } | null =>
    d.type === 'sell' ? { v: d.gain ?? 0, ron: d.gainRon } : d.net !== null ? { v: d.net, ron: d.netRon } : { v: -d.fee, ron: -d.feeRon };
  return (
    <Card title={`Detalierea tranzacțiilor (${report.details.length})`} padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-line">
              <th className={TH}>Data</th>
              <th className={TH}>Tip</th>
              <th className={TH}>Broker</th>
              <th className={TH}>Simbol</th>
              <th className={cx(TH, 'text-right')}>Cantitate</th>
              <th className={cx(TH, 'text-right')}>Încasare / Brut / Comision</th>
              <th className={cx(TH, 'text-right')}>Rezultat / Net</th>
              <th className={cx(TH, 'text-right')}>Curs</th>
              <th className={cx(TH, 'text-right')}>În lei</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const r = result(d);
              return (
                <tr key={d.id} className="border-b border-line last:border-0">
                  <td className={TD}>{fmtDate(d.date)}</td>
                  <td className={TD}>{TRANSACTION_TYPE_LABEL[d.type]}</td>
                  <td className={cx(TD, 'text-ink-2')}>
                    {d.brokerName}
                    {d.portfolioName && <span className="text-ink-3"> · {d.portfolioName}</span>}
                  </td>
                  <td className={cx(TD, 'font-semibold')}>{d.symbol ?? '—'}</td>
                  <td className={cx(TD, 'tabular text-right')}>{d.quantity === null ? '' : fmtQty(d.quantity)}</td>
                  <td className={cx(TD, 'tabular text-right')}>{value(d)}</td>
                  <td className={cx(TD, 'tabular text-right', r && r.v > 0 ? 'text-gain' : r && r.v < 0 ? 'text-loss' : '')}>{r ? money(r.v, d.currency) : ''}</td>
                  <td className={cx(TD, 'tabular text-right text-ink-2')}>
                    {d.fxSource === 'ron' ? '—' : d.fxRate.toLocaleString('ro-RO', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                    {d.fxSource !== 'ron' && <span className="block text-xs text-ink-3">{FX_SOURCE_LABEL[d.fxSource]}</span>}
                  </td>
                  <td className={cx(TD, 'tabular text-right')}>{r && r.ron !== null ? money(r.ron, 'RON') : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {report.details.length > DETAIL_PAGE && !all && (
        <div className="p-3 text-center">
          <Button size="sm" onClick={() => setAll(true)}>
            Arată toate cele {report.details.length} tranzacții
          </Button>
        </div>
      )}
    </Card>
  );
}

export function TaxReportPage() {
  const { portfolios, dataVersion, notify } = useApp();
  const today = todayIso();
  // Între ianuarie și mai (perioada Declarației Unice) se deschide anul trecut; altfel anul curent.
  const [year, setYear] = useState(Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) <= 5 ? 1 : 0));
  const [portfolioId, setPortfolioId] = useState<number | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
  const report = useLoad(() => api.tax.report(year, portfolioId), [year, portfolioId, dataVersion]);
  const r = report.data;

  const exportFile = async (kind: 'pdf' | 'csv'): Promise<void> => {
    setBusy(kind);
    try {
      const res = kind === 'pdf' ? await api.tax.exportPdf(year, portfolioId) : await api.tax.exportCsv(year, portfolioId);
      if (!res.canceled) notify('success', `Raportul fiscal ${year} a fost salvat în ${res.path}.`);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const years = r?.years.includes(year) ? r.years : [...(r?.years ?? []), year].sort((a, b) => b - a);
  const sources = r
    ? (Object.entries(r.fxSources) as [FxSource, number][])
        .filter(([k, v]) => v > 0 && k !== 'ron')
        .map(([k, v]) => `${FX_SOURCE_LABEL[k]} (${v})`)
        .join(', ')
    : '';

  return (
    <>
      <Notice tone="accent">
        <span className="font-medium">{TAX_DISCLAIMER}</span>{' '}
        Aplicația nu calculează impozitul de plată, doar totalizează cifrele.
      </Notice>

      <div className="flex flex-wrap items-center gap-3">
        <Select className="w-28!" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} aria-label="Anul raportului">
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <Select
          className="w-72! max-md:w-full!"
          value={portfolioId === null ? '' : String(portfolioId)}
          onChange={(e) => setPortfolioId(e.target.value ? Number(e.target.value) : null)}
          aria-label="Portofoliul raportului"
        >
          <option value="">Toate portofoliile (inclusiv arhivate)</option>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.archived ? ' (arhivat)' : ''}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex gap-2">
          <Button icon={<FileDown className="size-4" />} loading={busy === 'csv'} disabled={!r || r.details.length === 0} onClick={() => void exportFile('csv')}>
            Export CSV
          </Button>
          <Button variant="primary" icon={<FileText className="size-4" />} loading={busy === 'pdf'} disabled={!r} onClick={() => void exportFile('pdf')}>
            Export PDF
          </Button>
        </div>
      </div>

      {report.error && <LoadError message={report.error} onRetry={report.reload} />}
      {!r ? (
        !report.error && <PageSkeleton />
      ) : (
        <>
          {r.bnrNotice && <Notice tone="warn">{r.bnrNotice}</Notice>}
          {r.details.length === 0 ? (
            <Card>
              <EmptyState icon={<FileText className="size-5" />} title={`Nimic de raportat în ${year}`} text="Nu există vânzări, dividende, cupoane, dobânzi sau comisioane în acest an." />
            </Card>
          ) : (
            <>
              <p className="text-xs text-ink-2">
                Sumele în lei sunt la cursul din ziua fiecărei tranzacții{sources ? `: ${sources}` : ''}. Costul unităților vândute este la cursul din zilele de cumpărare
                {r.costMethod === 'FIFO' ? ', după metoda FIFO' : ', la costul mediu ponderat'} (se schimbă din Setări). Tipul fiecărui broker (România / străin) se schimbă din pagina Brokeri.
              </p>
              {r.sections.map((s) => (
                <SectionCard key={s.residence} section={s} />
              ))}
              <Details report={r} />
            </>
          )}
        </>
      )}
    </>
  );
}
