/**
 * Simulatorul „ce-ar fi fost dacă”: depunerile tale investite în piață, o investiție lunară (DCA)
 * sau o investiție unică, într-un ETF, un indice sau orice alt simbol. Cu dividende reinvestite,
 * conversie valutară și comision. Istoricul se descarcă o dată și se păstrează local.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { FlaskConical, Play } from 'lucide-react';
import type { SimulationMode, SimulationResult } from '@shared/types';
import { SIM_PRESETS } from '@shared/simulator';
import { parseNumberLoose } from '@shared/csv';
import { addMonths, todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { date as fmtDate, money, signedMoney, signedPercent } from '../lib/format';
import { SimulationChart } from '../components/charts';
import { Button, Card, EmptyState, Field, Input, Notice, PageSkeleton, Segmented, Select, cx } from '../components/ui';

const MODES: { value: SimulationMode; label: string }[] = [
  { value: 'market', label: 'Depunerile mele în piață' },
  { value: 'dca', label: 'Investiție lunară' },
  { value: 'lump', label: 'Investiție unică' }
];
const OTHER = '__other__';

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: 'gain' | 'loss' | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <p className={cx('tabular mt-1 text-stat font-semibold', tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : 'text-ink')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function SimulatorPage() {
  const { filter, settings } = useApp();
  const base = settings?.baseCurrency ?? 'RON';
  const [mode, setMode] = useState<SimulationMode>('market');
  const [preset, setPreset] = useState(SIM_PRESETS[0].symbol);
  const [custom, setCustom] = useState('');
  const [amount, setAmount] = useState('500');
  const [start, setStart] = useState(addMonths(todayIso(), -60));
  const [dividends, setDividends] = useState(true);
  const [fee, setFee] = useState('0');
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const symbol = preset === OTHER ? custom.trim().toUpperCase() : preset;

  const run = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    setError(null);
    const feePct = (parseNumberLoose(fee) ?? 0) / 100;
    if (!symbol) return setError('Scrie simbolul instrumentului (ex.: AAPL, VWCE.DE).');
    setRunning(true);
    try {
      setResult(
        await api.simulator.run({
          mode,
          symbol,
          includeDividends: dividends,
          feePct,
          amount: mode === 'market' ? undefined : (parseNumberLoose(amount) ?? undefined),
          startDate: mode === 'market' ? undefined : start,
          filter: { portfolioId: filter.portfolioId ?? null }
        })
      );
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  // La deschidere: comparația depunerilor tale cu S&P 500 (un singur clic mai puțin).
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.portfolioId]);

  const r = result;
  const verdict =
    r && r.mode === 'market' && r.actualValue !== null
      ? r.finalValue - r.actualValue
      : null;

  return (
    <>
      <p className="max-w-3xl text-body text-ink-2">
        Ce-ar fi fost dacă… Compară portofoliul tău cu piața sau vezi cât ar fi adus o investiție lunară ori una unică. Sumele se convertesc la cursul fiecărei zile; istoricul se descarcă o dată și rămâne salvat.
      </p>

      <Card>
        <form onSubmit={run} className="space-y-4">
          <Segmented<SimulationMode> value={mode} onChange={setMode} options={MODES} />
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Instrument">
              <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Instrument">
                {SIM_PRESETS.map((p) => (
                  <option key={p.symbol} value={p.symbol}>
                    {p.name}
                  </option>
                ))}
                <option value={OTHER}>Alt simbol…</option>
              </Select>
            </Field>
            {preset === OTHER && (
              <Field label="Simbol" hint="Ca pe Yahoo Finance: AAPL, VWCE.DE, TLV.RO, BTC-USD">
                <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="ex.: AAPL" maxLength={20} autoFocus />
              </Field>
            )}
            {mode !== 'market' && (
              <>
                <Field label={mode === 'dca' ? `Suma lunară (${base})` : `Suma investită (${base})`}>
                  <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label={mode === 'dca' ? 'Începând cu' : 'Data investiției'}>
                  <Input type="date" value={start} max={todayIso()} onChange={(e) => setStart(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Comision la fiecare cumpărare (%)">
              <Input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-body text-ink">
              <input type="checkbox" className="size-4 accent-accent" checked={dividends} onChange={(e) => setDividends(e.target.checked)} />
              Dividende reinvestite
            </label>
            <Button variant="primary" type="submit" loading={running} icon={<Play className="size-4" />} className="ml-auto">
              Simulează
            </Button>
          </div>
          {error && <Notice tone="loss">{error}</Notice>}
        </form>
      </Card>

      {running && !r ? (
        <PageSkeleton />
      ) : !r ? (
        !error && (
          <Card>
            <EmptyState icon={<FlaskConical className="size-5" />} title="Alege instrumentul și apasă „Simulează”" />
          </Card>
        )
      ) : (
        <>
          {verdict !== null && r.actualValue !== null && (
            <div className={cx('rounded-xl border px-4 py-3', verdict > 0 ? 'border-warn/40 bg-warn/5' : 'border-gain/30 bg-gain/5')}>
              <p className="text-base font-semibold text-ink">
                Dacă depunerile tale ar fi fost investite în {r.name}, azi ai avea {money(r.finalValue, r.baseCurrency)}.
              </p>
              <p className="mt-0.5 text-body text-ink-2">
                Portofoliul tău real valorează {money(r.actualValue, r.baseCurrency)}:{' '}
                <strong className={verdict > 0 ? 'text-loss' : 'text-gain'}>
                  {verdict > 0 ? `cu ${money(verdict, r.baseCurrency)} mai puțin` : `cu ${money(-verdict, r.baseCurrency)} mai mult`}
                </strong>{' '}
                decât varianta „{r.symbol}”.
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={r.mode === 'market' ? `Valoarea în ${r.symbol}, azi` : 'Valoarea de azi'} value={money(r.finalValue, r.baseCurrency)} />
            <Stat label="Investit net" value={money(r.invested, r.baseCurrency)} hint={`de la ${fmtDate(r.startDate)}`} />
            <Stat label="Câștig" value={signedMoney(r.gain, r.baseCurrency)} tone={r.gain >= 0 ? 'gain' : 'loss'} hint={r.gainPct !== null ? signedPercent(r.gainPct, 1) : undefined} />
            <Stat
              label="Randament anual"
              value={r.annualized === null ? '—' : signedPercent(r.annualized, 1)}
              hint={`Comisioane ${money(r.fees, r.baseCurrency)}${r.reinvested > 0 ? ` · dividende reinvestite ${money(r.reinvested, r.baseCurrency)}` : ''}`}
            />
          </div>
          <Card title={`Evoluția: ${r.name}`}>
            <SimulationChart data={r.points} currency={r.baseCurrency} name={r.mode === 'market' ? `Depunerile tale în ${r.symbol}` : r.symbol} />
            <ul className="mt-3 space-y-1 text-xs text-ink-3">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>Rezultatele trecute nu garantează rezultatele viitoare. Nu includ impozitele.</li>
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
