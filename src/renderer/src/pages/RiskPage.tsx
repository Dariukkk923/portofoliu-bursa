/**
 * Ecranul „Risc”: cât de concentrat este portofoliul, pe ce sectoare, țări și monede
 * este expus, cât de mult variază și cât a scăzut cel mai mult, cât de mult urmează
 * piața (beta) și un scor general de diversificare, cu sugestii concrete. Fiecare
 * indicator are o explicație scurtă, în cuvinte simple.
 */
import { useState, type ReactNode } from 'react';
import { CircleAlert, FileUp, Lightbulb } from 'lucide-react';
import type { HistoryRange, RiskReport } from '@shared/types';
import { RANGE_LABEL } from '@shared/labels';
import { api } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, percent, signedPercent } from '../lib/format';
import { AllocationDonut } from '../components/charts';
import { TickerLogo } from '../components/TickerLogo';
import { Badge, Button, Card, EmptyState, LoadError, PageSkeleton, Segmented, Select, TD, TH, cx } from '../components/ui';

const RANGES: HistoryRange[] = ['6M', '1Y', 'ALL'];
const LIMITS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];

/** O cifră principală cu explicația ei. */
function Metric({ label, value, tone, children }: { label: string; value: ReactNode; tone?: 'gain' | 'loss' | 'warn' | null; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <div className={cx('tabular mt-1 text-stat font-semibold', tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : tone === 'warn' ? 'text-warn' : 'text-ink')}>{value}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

/** Scorul 1–10 ca bară: verde de la 7, galben 4–6, roșu sub 4. */
function ScoreMeter({ score }: { score: number }) {
  const tone = score >= 7 ? 'var(--gain)' : score >= 4 ? 'var(--warn)' : 'var(--loss)';
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={1} aria-valuemax={10} aria-valuenow={score} aria-label="Scor de diversificare">
      <div className="h-full rounded-full" style={{ width: `${score * 10}%`, background: tone }} />
    </div>
  );
}

const volatilityWords = (v: number): string => (v < 0.1 ? 'liniștit' : v < 0.2 ? 'moderat' : v < 0.3 ? 'agitat' : 'foarte agitat');

function betaText(beta: number, name: string): string {
  if (beta < 0) return `Portofoliul tinde să se miște invers față de ${name}.`;
  if (Math.abs(beta - 1) < 0.05) return `Portofoliul se mișcă aproape la fel ca ${name}.`;
  const pct = Math.round(Math.abs(beta - 1) * 100);
  return beta > 1
    ? `Când ${name} urcă sau scade 1%, portofoliul tău se mișcă de obicei cu ${(beta).toLocaleString('ro-RO', { maximumFractionDigits: 2 })}% (cu ${pct}% mai mult).`
    : `Când ${name} urcă sau scade 1%, portofoliul tău se mișcă de obicei cu ${(beta).toLocaleString('ro-RO', { maximumFractionDigits: 2 })}% (mai liniștit decât piața).`;
}

export function RiskPage() {
  const { filter, dataVersion, settings, updateSettings, requestImport } = useApp();
  const [range, setRange] = useState<HistoryRange>('1Y');
  const report = useLoad(() => api.portfolio.risk(range, filter), [range, filter, dataVersion, settings?.concentrationLimit]);
  const r = report.data;

  if (!r) {
    return report.error ? <LoadError message={report.error} onRetry={report.reload} /> : <PageSkeleton />;
  }
  if (r.positions.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CircleAlert className="size-5" />}
          title="Nicio poziție deschisă"
          text="Analiza de risc apare după ce adaugi primele active în portofoliu."
          action={
            <Button variant="primary" icon={<FileUp className="size-4" />} onClick={requestImport}>
              Importă extrasul de la broker
            </Button>
          }
        />
      </Card>
    );
  }

  const benchName = r.benchmark.name.replace(/ \(prin ETF-ul .*\)$/, '');
  const over = r.positions.filter((p) => p.weight > r.concentrationLimit);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-body text-ink-2">
          Valoarea analizată: <strong className="tabular text-ink">{money(r.holdingsValue, r.baseCurrency)}</strong> în {r.positions.length === 1 ? '1 poziție' : `${r.positions.length} poziții`}
          {Math.abs(r.cash) >= 0.005 && <> · plus cash {money(r.cash, r.baseCurrency)}</>}
        </p>
        <span className="text-xs text-ink-3">Volatilitate, scădere și beta pe:</span>
        <Segmented size="sm" value={range} onChange={setRange} options={RANGES.map((x) => ({ value: x, label: RANGE_LABEL[x] }))} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
          <p className="text-xs font-medium text-ink-2">Scor de diversificare</p>
          <div className="tabular mt-1 text-stat font-semibold text-ink">
            {r.score}
            <span className="text-sm font-medium text-ink-3"> / 10</span>
          </div>
          <ScoreMeter score={r.score} />
          <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
            Ca și cum ai avea ≈ {Math.max(1, Math.round(r.effectivePositions))} {Math.round(r.effectivePositions) === 1 ? 'poziție egală' : 'poziții egale'}. Ține cont de numărul și mărimea pozițiilor, de sectoare, țări, monede și tipuri de active.
          </p>
        </div>
        <Metric label="Volatilitate anualizată" value={percent(r.volatility, 1)} tone={r.volatility !== null && r.volatility >= 0.3 ? 'warn' : null}>
          {r.volatility === null
            ? 'Sunt prea puține date în intervalul ales.'
            : `Cât variază de obicei valoarea portofoliului într-un an: ${volatilityWords(r.volatility)}. Sub 10% e liniștit, peste 25% e agitat.`}
        </Metric>
        <Metric label="Cea mai mare scădere" value={r.maxDrawdown ? signedPercent(r.maxDrawdown.value, 1) : '—'} tone={r.maxDrawdown ? 'loss' : null}>
          {r.maxDrawdown
            ? `De la vârful din ${fmtDate(r.maxDrawdown.peakDate)} până la minimul din ${fmtDate(r.maxDrawdown.troughDate)}; ${r.maxDrawdown.recoveryDate ? `a revenit pe ${fmtDate(r.maxDrawdown.recoveryDate)}` : 'nu a revenit încă la vârf'}.`
            : 'Portofoliul nu a scăzut sub un vârf anterior în intervalul ales.'}
        </Metric>
        <Metric label={`Beta față de ${benchName}`} value={r.beta === null ? '—' : r.beta.toLocaleString('ro-RO', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}>
          {r.beta === null ? 'Sunt prea puține zile comune cu indicele în intervalul ales.' : betaText(r.beta, benchName)}
        </Metric>
      </div>

      <Card title={<span className="flex items-center gap-1.5"><Lightbulb className="size-4 text-warn" aria-hidden /> Ce poți îmbunătăți</span>}>
        <ul className="space-y-2 text-body text-ink">
          {r.suggestions.map((s) => (
            <li key={s} className="flex gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink-3" aria-hidden />
              {s}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-3">Sugestiile sunt calcule simple pe datele tale, nu recomandări de investiții.</p>
      </Card>

      <Card
        title="Concentrare: ponderea fiecărei poziții"
        padded={false}
        action={
          <label className="flex items-center gap-2 text-xs text-ink-2">
            Avertizează peste
            <Select
              className="w-28!"
              value={String(r.concentrationLimit)}
              onChange={(e) => void updateSettings({ concentrationLimit: Number(e.target.value) })}
              aria-label="Pragul de concentrare"
            >
              {[...new Set([...LIMITS, r.concentrationLimit])].sort((a, b) => a - b).map((l) => (
                <option key={l} value={String(l)}>
                  {percent(l, 0)}
                </option>
              ))}
            </Select>
          </label>
        }
      >
        <p className="px-4 pb-3 text-xs text-ink-2">
          O poziție mare face ca o singură companie să conteze mult: dacă scade cu 30% și are 40% din portofoliu, pierzi 12% din tot.
          {over.length > 0 ? ` ${over.length === 1 ? 'O poziție depășește' : `${over.length} poziții depășesc`} pragul de ${percent(r.concentrationLimit, 0)}.` : ''}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-y border-line">
                <th className={TH}>Poziție</th>
                <th className={TH}>Sector</th>
                <th className={TH}>Țară</th>
                <th className={cx(TH, 'text-right')}>Valoare</th>
                <th className={cx(TH, 'w-[34%]')}>Pondere</th>
              </tr>
            </thead>
            <tbody>
              {r.positions.map((p) => {
                const high = p.weight > r.concentrationLimit;
                return (
                  <tr key={p.assetId} className="border-b border-line last:border-0">
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        <TickerLogo symbol={p.symbol} type={p.type} size={24} />
                        <span className="font-semibold">{p.symbol}</span>
                        <span className="max-w-40 truncate text-xs text-ink-3">{p.name}</span>
                      </span>
                    </td>
                    <td className={cx(TD, p.sector === 'Necunoscut' ? 'text-ink-3' : 'text-ink-2')}>{p.sector}</td>
                    <td className={cx(TD, 'text-ink-2')}>{p.country}</td>
                    <td className={cx(TD, 'tabular text-right')}>{money(p.value, r.baseCurrency)}</td>
                    <td className={TD}>
                      <div className="flex items-center gap-2">
                        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <div className="h-full rounded-full" style={{ width: `${Math.min(100, p.weight * 100)}%`, background: high ? 'var(--warn)' : 'var(--series-1)' }} />
                          <div className="absolute top-0 h-full w-px bg-ink-3" style={{ left: `${r.concentrationLimit * 100}%` }} aria-hidden />
                        </div>
                        <span className={cx('tabular w-14 text-right font-medium', high ? 'text-warn' : 'text-ink')}>{percent(p.weight, 1)}</span>
                        {high && <Badge tone="warn">peste prag</Badge>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {r.unknownSector.length > 0 && (
          <p className="px-4 py-2.5 text-xs text-ink-3">
            Sectorul lipsește pentru {r.unknownSector.join(', ')}. Se completează automat de la providerul de date sau manual: Portofoliu → creionul de lângă activ.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Exposure title="Expunere pe sector" report={r} slices={r.bySector}>
          Un singur domeniu (ex.: tehnologie) poate scădea tot odată, din aceleași motive. ETF-urile pe mai multe sectoare apar separat.
        </Exposure>
        <Exposure title="Expunere pe țară" report={r} slices={r.byCountry}>
          Companiile dintr-o țară depind de aceeași economie și de aceleași legi.
        </Exposure>
        <Exposure title="Expunere pe monedă (inclusiv cash)" report={r} slices={r.byCurrency}>
          Pentru activele în altă monedă decât {r.baseCurrency}, rezultatul depinde și de curs: dacă moneda se depreciază, pierzi chiar dacă prețul nu se schimbă.
        </Exposure>
        <Exposure title="Expunere pe tip de activ" report={r} slices={r.byType}>
          Acțiunile cresc mai mult pe termen lung, dar variază mai tare; obligațiunile sunt mai stabile.
        </Exposure>
      </div>
    </>
  );
}

function Exposure({ title, report, slices, children }: { title: string; report: RiskReport; slices: RiskReport['bySector']; children: ReactNode }) {
  // Culoarea urmează eticheta (ordine alfabetică stabilă), nu mărimea feliei.
  const order = [...slices.map((s) => s.key)].sort((a, b) => a.localeCompare(b, 'ro'));
  return (
    <Card title={title}>
      <AllocationDonut slices={slices} currency={report.baseCurrency} order={order} />
      <p className="mt-3 text-xs text-ink-2">{children}</p>
    </Card>
  );
}
