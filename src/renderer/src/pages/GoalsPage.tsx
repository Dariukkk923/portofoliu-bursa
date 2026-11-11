/**
 * Obiectivele financiare: suma-țintă (opțional cu dată), progresul și proiecția Monte Carlo
 * (5.000 de scenarii lunare) cu datele completate din aplicație: valoarea actuală, contribuția
 * lunară medie, randamentul și volatilitatea (ale tale sau ale indicelui). Sliderele schimbă
 * contribuția și randamentul cu rezultat imediat; comutatorul arată valorile în bani de azi.
 */
import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Target, Trash2 } from 'lucide-react';
import { ASSET_TYPES, type AssetType, type Goal, type GoalInput, type GoalSource, type GoalView } from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { parseNumberLoose } from '@shared/csv';
import { addMonths, daysBetween, todayIso } from '@shared/dates';
import { monteCarlo, monthsToTarget, requiredMonthlyContribution } from '@shared/calc';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, monthsText, percent } from '../lib/format';
import { GoalFanChart, type FanPoint } from '../components/charts';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, LoadError, Modal, Notice, Segmented, Select, Skeleton } from '../components/ui';

const DISCLAIMER = 'Proiecție estimativă bazată pe date istorice, nu garanție. Piața poate evolua diferit.';
const SCENARIOS = 5000;
const SOURCE_LABEL: Record<'personal' | 'benchmark' | 'manual', string> = { personal: 'istoricul tău', benchmark: 'indicele de referință', manual: 'valoare aleasă' };
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const monthYear = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const pctText = (v: number, digits = 1): string => `${(v * 100).toLocaleString('ro-RO', { maximumFractionDigits: digits })}%`;

/** Lunile întregi de azi până la o dată (cel puțin 1). */
const monthsUntil = (today: string, date: string): number => Math.max(1, Math.round(daysBetween(today, date) / 30.44));

/* ------------------------------------------------------------ formular */

function SourcePicker({ label, value, onChange, manual, onManual, hint }: { label: string; value: GoalSource; onChange: (v: GoalSource) => void; manual: string; onManual: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<GoalSource>
          size="sm"
          value={value}
          onChange={onChange}
          options={[
            { value: 'auto', label: 'Automat' },
            { value: 'personal', label: 'Al meu' },
            { value: 'benchmark', label: 'Indicele' },
            { value: 'manual', label: 'Manual' }
          ]}
        />
        {value === 'manual' && <Input className="w-24!" inputMode="decimal" value={manual} onChange={(e) => onManual(e.target.value)} placeholder="%" aria-label={`${label} (%)`} />}
      </div>
    </Field>
  );
}

function GoalForm({ goal, onClose, onSaved }: { goal: GoalView | null; onClose: () => void; onSaved: () => void }) {
  const { portfolios, brokers, notify, filter } = useApp();
  const pct = (v: number | null | undefined): string => (v == null ? '' : String(Number((v * 100).toFixed(2))).replace('.', ','));
  const [name, setName] = useState(goal?.name ?? '');
  const [target, setTarget] = useState(goal ? String(goal.targetAmount).replace('.', ',') : '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [portfolioId, setPortfolioId] = useState<number | null>(goal ? goal.portfolioId : (filter.portfolioId ?? null));
  const [brokerId, setBrokerId] = useState<number | null>(goal?.brokerId ?? null);
  const [assetType, setAssetType] = useState<AssetType | null>(goal?.assetType ?? null);
  const [monthly, setMonthly] = useState(goal?.monthlyContribution == null ? '' : String(goal.monthlyContribution).replace('.', ','));
  const [returnSource, setReturnSource] = useState<GoalSource>(goal?.returnSource ?? 'auto');
  const [manualReturn, setManualReturn] = useState(pct(goal?.manualReturn));
  const [volatilitySource, setVolatilitySource] = useState<GoalSource>(goal?.volatilitySource ?? 'auto');
  const [manualVolatility, setManualVolatility] = useState(pct(goal?.manualVolatility));
  const [inflation, setInflation] = useState(pct(goal?.inflation ?? 0.04));
  const [advanced, setAdvanced] = useState(!!goal);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const amount = parseNumberLoose(target);
    if (amount === null || amount <= 0) return setError('Scrie suma-țintă.');
    const asFraction = (s: string): number | null => {
      const v = parseNumberLoose(s);
      return v === null ? null : v / 100;
    };
    const input: GoalInput = {
      name,
      targetAmount: amount,
      targetDate: targetDate || null,
      portfolioId,
      brokerId,
      assetType,
      monthlyContribution: monthly.trim() ? parseNumberLoose(monthly) : null,
      returnSource,
      manualReturn: returnSource === 'manual' ? asFraction(manualReturn) : null,
      volatilitySource,
      manualVolatility: volatilitySource === 'manual' ? asFraction(manualVolatility) : null,
      inflation: asFraction(inflation) ?? 0.04
    };
    setSaving(true);
    try {
      if (goal) await api.goals.update(goal.id, input);
      else await api.goals.create(input);
      notify('success', goal ? 'Obiectivul a fost modificat.' : 'Obiectivul a fost adăugat.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const auto = goal?.inputs;
  return (
    <Modal
      title={goal ? 'Editează obiectivul' : 'Obiectiv nou'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="goal-form" loading={saving}>
            Salvează
          </Button>
        </>
      }
    >
      <form id="goal-form" onSubmit={submit} className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Numele obiectivului">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Fond pentru casă" maxLength={60} required autoFocus />
          </Field>
          <Field label={`Suma-țintă${auto ? ` (${auto.currency})` : ''}`}>
            <Input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="ex.: 100000" required />
          </Field>
        </div>
        <Field label="Data-țintă (opțional)" hint="Cu dată: vezi șansele de a ajunge la timp și cât trebuie să depui lunar.">
          <Input type="date" value={targetDate} min={todayIso()} onChange={(e) => setTargetDate(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Portofoliul">
            <Select value={portfolioId ?? ''} onChange={(e) => setPortfolioId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Toate portofoliile</option>
              {portfolios
                .filter((p) => !p.archived || p.id === portfolioId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Brokerul">
            <Select value={brokerId ?? ''} onChange={(e) => setBrokerId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Toți brokerii</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Activele">
            <Select value={assetType ?? ''} onChange={(e) => setAssetType((e.target.value || null) as AssetType | null)}>
              <option value="">Toate (cu cash)</option>
              {ASSET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ASSET_TYPE_LABEL_PLURAL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <button type="button" className="flex items-center gap-1.5 text-body font-medium text-ink" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
          {advanced ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
          Datele proiecției <span className="font-normal text-ink-3">(completate automat din aplicație)</span>
        </button>
        {advanced && (
          <div className="space-y-3.5 rounded-lg border border-line p-3">
            <Field
              label="Contribuția lunară"
              hint={auto ? `Gol = automat: media depunerilor nete din ultimele 12 luni (${money(auto.averageContribution, auto.currency)}).` : 'Gol = automat: media depunerilor nete din ultimele 12 luni.'}
            >
              <Input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="automat" />
            </Field>
            <SourcePicker
              label="Randamentul anual așteptat"
              value={returnSource}
              onChange={setReturnSource}
              manual={manualReturn}
              onManual={setManualReturn}
              hint={
                auto
                  ? `Al tău (TWR anualizat): ${auto.personal.annualReturn === null ? '—' : pctText(auto.personal.annualReturn)} · ${auto.benchmark.name} pe termen lung: ${auto.benchmark.annualReturn === null ? '—' : pctText(auto.benchmark.annualReturn)}. Automat = al tău, dacă ai cel puțin 2 ani de istoric.`
                  : 'Automat = randamentul tău, dacă ai cel puțin 2 ani de istoric, altfel cel al indicelui pe termen lung.'
              }
            />
            <SourcePicker
              label="Volatilitatea anuală"
              value={volatilitySource}
              onChange={setVolatilitySource}
              manual={manualVolatility}
              onManual={setManualVolatility}
              hint={auto ? `A ta: ${auto.personal.volatility === null ? '—' : pctText(auto.personal.volatility)} · a indicelui: ${auto.benchmark.volatility === null ? '—' : pctText(auto.benchmark.volatility)}.` : undefined}
            />
            <Field label="Inflația anuală (%)" hint="Pentru afișarea rezultatului în bani de azi.">
              <Input className="w-28!" inputMode="decimal" value={inflation} onChange={(e) => setInflation(e.target.value)} />
            </Field>
          </div>
        )}
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ proiecția */

function GoalCard({ g, onEdit, onDelete }: { g: GoalView; onEdit: () => void; onDelete: () => void }) {
  const today = todayIso();
  const cur = g.inputs.currency;
  const [monthly, setMonthly] = useState(g.effective.monthly);
  const [ret, setRet] = useState(g.effective.annualReturn);
  const [real, setReal] = useState(false);
  useEffect(() => {
    setMonthly(g.effective.monthly);
    setRet(g.effective.annualReturn);
  }, [g.effective.monthly, g.effective.annualReturn]);
  const m = useDeferredValue(monthly);
  const r = useDeferredValue(ret);
  const vol = g.effective.volatility;
  const start = g.inputs.currentValue;
  const targetMonth = g.targetDate ? monthsUntil(today, g.targetDate) : null;

  const mc = useMemo(() => {
    const realRate = real ? (1 + r) / (1 + g.inflation) - 1 : r;
    const det = monthsToTarget(start, m, realRate, g.targetAmount, 600);
    const horizon = Math.min(480, Math.max(24, targetMonth ?? 0, det !== null ? Math.ceil(det * 2) : 360));
    return { horizon, ...monteCarlo({ start, monthly: m, annualReturn: r, annualVolatility: vol, months: horizon, scenarios: SCENARIOS, seed: g.id, target: g.targetAmount, targetMonth, inflation: g.inflation, real }) };
  }, [start, m, r, vol, real, g.targetAmount, g.inflation, g.id, targetMonth]);

  const chart: FanPoint[] = useMemo(() => {
    const step = mc.horizon > 240 ? 3 : mc.horizon > 120 ? 2 : 1;
    const past = g.inputs.history.filter((p) => p.date < today).map((p) => ({ date: p.date, history: p.value, median: null, band: null }));
    const future: FanPoint[] = [];
    for (let k = 0; k <= mc.horizon; k += step) {
      future.push({ date: addMonths(today, k), history: k === 0 ? start : null, median: mc.p50[k], band: [mc.p10[k], mc.p90[k]] });
    }
    return [...past, ...future];
  }, [mc, g.inputs.history, start, today]);

  // Contribuția necesară până la data-țintă, cu creșterea mediană (cea a scenariului realist).
  const medianAnnual = (1 + r) * Math.exp(-(vol * vol) / 2) - 1;
  const needRate = real ? (1 + medianAnnual) / (1 + g.inflation) - 1 : medianAnnual;
  const need = targetMonth !== null ? requiredMonthlyContribution(start, g.targetAmount, needRate, targetMonth) : null;
  const atTarget = targetMonth !== null && targetMonth <= mc.horizon ? { p10: mc.p10[targetMonth], p50: mc.p50[targetMonth], p90: mc.p90[targetMonth] } : null;
  const years = Math.round(mc.horizon / 12);
  const changed = Math.abs(monthly - g.effective.monthly) > 0.5 || Math.abs(ret - g.effective.annualReturn) > 1e-6;
  const maxRet = Math.max(0.15, Math.ceil(Math.max(ret, g.effective.annualReturn) * 20) / 20);
  const maxMonthly = Math.max(5000, Math.ceil((g.effective.monthly * 3) / 100) * 100, Math.ceil(monthly / 100) * 100);

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Target className="size-4 text-accent" aria-hidden /> {g.name}
          <span className="text-xs font-normal text-ink-3">{g.scopeLabel}</span>
        </span>
      }
      action={
        <div className="flex">
          <IconButton label={`Editează obiectivul ${g.name}`} onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label={`Șterge obiectivul ${g.name}`} onClick={onDelete}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-body text-ink-2">
          <strong className="tabular text-lg text-ink">{money(start, cur)}</strong> din {money(g.targetAmount, cur)}
          {g.targetDate && <span className="text-ink-3"> · până la {fmtDate(g.targetDate)}</span>}
        </p>
        <span className="tabular text-body font-semibold text-ink">{percent(g.progress, 0)}</span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(g.progress * 100)} aria-label={`Progres ${g.name}`}>
        <div className="h-full rounded-full bg-(--series-1)" style={{ width: `${g.progress * 100}%` }} />
      </div>

      {g.shortHistory && (
        <div className="mt-3">
          <Notice tone="warn">
            Istoricul tău are doar {monthsText(Math.max(0, Math.round(g.inputs.personal.years * 12)))}: randamentul personal nu e încă reprezentativ.
            {g.effective.returnFrom === 'benchmark'
              ? ` Proiecția folosește randamentul pe termen lung al ${g.inputs.benchmark.name}${g.inputs.benchmark.from ? ` (din ${g.inputs.benchmark.from.slice(0, 4)})` : ''}.`
              : ' Îți recomandăm randamentul pe termen lung al indicelui (Editează → Randamentul → Indicele).'}
          </Notice>
        </div>
      )}

      <div className="mt-4 space-y-1.5">
        <p className="text-base font-semibold text-ink">
          {mc.medianMonth === 0
            ? 'Ai atins deja obiectivul.'
            : mc.medianMonth !== null
              ? `Ajungi la ${money(g.targetAmount, cur, 0)} în aproximativ ${monthsText(mc.medianMonth)} (scenariu realist, mediana) – în ${monthYear(addMonths(today, mc.medianMonth))}.`
              : `În scenariul realist nu ajungi la ${money(g.targetAmount, cur, 0)} în următorii ${years} ani.`}
        </p>
        {mc.medianMonth !== 0 && (
          <p className="text-body text-ink-2">
            Pesimist (10%): {mc.slowMonth !== null ? monthsText(mc.slowMonth) : `peste ${years} ani`} · Optimist (90%): {mc.fastMonth !== null ? monthsText(mc.fastMonth) : `peste ${years} ani`}
          </p>
        )}
        {g.targetDate && mc.probabilityByTarget !== null && (
          <p className="text-body text-ink-2">
            <Badge tone={mc.probabilityByTarget >= 0.7 ? 'gain' : mc.probabilityByTarget >= 0.4 ? 'warn' : 'loss'}>{Math.round(mc.probabilityByTarget * 100)}% șanse</Badge> să ajungi până în{' '}
            {monthYear(g.targetDate)}
            {atTarget && (
              <>
                {' '}
                · atunci: între {money(atTarget.p10, cur, 0)} și {money(atTarget.p90, cur, 0)} (realist {money(atTarget.p50, cur, 0)})
              </>
            )}
          </p>
        )}
        {need !== null && (
          <p className="text-body text-ink-2">
            {need === 0
              ? `Ajungi până în ${g.targetDate?.slice(0, 4)} chiar fără depuneri noi (scenariu realist).`
              : `Ca să ajungi la obiectiv până în ${g.targetDate?.slice(0, 4)}, trebuie să depui aproximativ ${money(Math.ceil(need / 10) * 10, cur, 0)} pe lună.`}
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="flex justify-between text-xs font-medium text-ink-2">
            Contribuția lunară <span className="tabular text-ink">{money(monthly, cur, 0)}</span>
          </span>
          <input type="range" className="mt-1 w-full accent-accent" min={0} max={maxMonthly} step={maxMonthly > 10000 ? 100 : 50} value={monthly} onChange={(e) => setMonthly(Number(e.target.value))} aria-label="Contribuția lunară" />
        </label>
        <label className="block">
          <span className="flex justify-between text-xs font-medium text-ink-2">
            Randamentul anual <span className="tabular text-ink">{pctText(ret)}</span>
          </span>
          <input type="range" className="mt-1 w-full accent-accent" min={-0.05} max={maxRet} step={0.005} value={ret} onChange={(e) => setRet(Number(e.target.value))} aria-label="Randamentul anual" />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Segmented<'nominal' | 'real'>
          size="sm"
          value={real ? 'real' : 'nominal'}
          onChange={(v) => setReal(v === 'real')}
          options={[
            { value: 'nominal', label: 'Valori nominale' },
            { value: 'real', label: `În bani de azi (inflație ${pctText(g.inflation)})` }
          ]}
        />
        {changed && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-3.5" />}
            onClick={() => {
              setMonthly(g.effective.monthly);
              setRet(g.effective.annualReturn);
            }}
          >
            Înapoi la datele din aplicație
          </Button>
        )}
      </div>

      <div className="mt-4">
        <GoalFanChart data={chart} currency={cur} target={g.targetAmount} />
      </div>
      <p className="mt-2 text-xs text-ink-3">
        {SCENARIOS.toLocaleString('ro-RO')} de scenarii lunare · randament {pctText(r)}/an ({SOURCE_LABEL[g.effective.returnFrom]}) · volatilitate {pctText(vol)} ({SOURCE_LABEL[g.effective.volatilityFrom]}) · contribuție{' '}
        {money(m, cur, 0)}/lună (media ultimelor 12 luni: {money(g.inputs.averageContribution, cur, 0)}){real ? ' · valori în bani de azi' : ''}.
      </p>
    </Card>
  );
}

/** Obiectivele portofoliului ales sus (cele pentru „toate portofoliile” apar oriunde). */
const inScope = (g: Goal, portfolioId: number | null | undefined): boolean => portfolioId == null || g.portfolioId === null || g.portfolioId === portfolioId;

/** Pe panoul principal: progresul fiecărui obiectiv. */
export function GoalsSummary({ onOpen }: { onOpen: () => void }) {
  const { dataVersion, filter } = useApp();
  const list = useLoad(() => api.goals.list(), [dataVersion]);
  const goals = (list.data ?? []).filter((g) => inScope(g, filter.portfolioId));
  if (goals.length === 0) return null;
  return (
    <Card
      title="Obiective"
      action={
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Vezi proiecțiile
        </Button>
      }
    >
      <ul className="space-y-3">
        {goals.map((g) => (
          <li key={g.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-body">
              <span className="font-semibold text-ink">{g.name}</span>
              <span className="tabular text-ink-2">
                {money(g.inputs.currentValue, g.inputs.currency, 0)} / {money(g.targetAmount, g.inputs.currency, 0)} · <strong className="text-ink">{percent(g.progress, 0)}</strong>
                {g.targetDate && <span className="text-ink-3"> · {fmtDate(g.targetDate)}</span>}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(g.progress * 100)} aria-label={`Progres ${g.name}`}>
              <div className="h-full rounded-full bg-(--series-1)" style={{ width: `${g.progress * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function GoalsPage() {
  const { dataVersion, bumpData, notify, filter } = useApp();
  const list = useLoad(() => api.goals.list(), [dataVersion]);
  const goals = list.data?.filter((g) => inScope(g, filter.portfolioId)) ?? null;
  const [form, setForm] = useState<{ goal: GoalView | null } | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.goals.remove(deleting.id);
      notify('success', `Obiectivul „${deleting.name}” a fost șters.`);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-3xl text-body text-ink-2">Stabilește cât vrei să strângi și, opțional, până când. Aplicația estimează când ajungi acolo, din valoarea actuală, depunerile tale și randamentul așteptat.</p>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ goal: null })}>
          Adaugă obiectiv
        </Button>
      </div>
      <Notice tone="accent">{DISCLAIMER}</Notice>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : !goals ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : goals.length === 0 ? (
        <Card>
          <EmptyState icon={<Target className="size-5" />} title="Niciun obiectiv încă"
            text="De exemplu: „100.000 RON până în 2032” sau „Avans pentru casă”."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ goal: null })}>
                Adaugă primul obiectiv
              </Button>
            }
          />
        </Card>
      ) : (
        goals.map((g) => <GoalCard key={g.id} g={g} onEdit={() => setForm({ goal: g })} onDelete={() => setDeleting(g)} />)
      )}

      {form && (
        <GoalForm
          goal={form.goal}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            bumpData();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Ștergi obiectivul?"
          message={`Obiectivul „${deleting.name}” se șterge. Datele portofoliului rămân neatinse.`}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

