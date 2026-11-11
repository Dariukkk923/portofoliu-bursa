/**
 * Cardurile de pe panou despre bani: cash-ul disponibil la brokeri (cu ajustarea
 * soldului), totalul depus net față de valoarea actuală și randamentul (TWR și XIRR).
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { CircleHelp, Plus, SlidersHorizontal } from 'lucide-react';
import type { Asset, CashBalanceView, PerformanceData, PortfolioTotals } from '@shared/types';
import { parseNumberLoose } from '@shared/csv';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { money, signedMoney, signedPercent } from '../lib/format';
import { TransactionForm, type TransactionPreset } from './TransactionForm';
import { Button, Card, Field, IconButton, Input, Modal, Notice, Pnl } from './ui';

/** Corectarea soldului: utilizatorul scrie soldul real de la broker, iar aplicația înregistrează diferența. */
function AdjustDialog({ balance, onClose, onSaved }: { balance: CashBalanceView; onClose: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const [actual, setActual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = parseNumberLoose(actual);
  const diff = value === null ? null : Math.round((value - balance.amount) * 100) / 100;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (diff === null) return setError('Scrie soldul afișat de broker.');
    if (diff === 0) return onClose();
    setSaving(true);
    try {
      await api.transactions.create({
        type: 'adjustment',
        portfolioId: balance.portfolioId,
        assetId: null,
        brokerId: balance.brokerId,
        currency: balance.currency,
        date: todayIso(),
        amount: diff,
        notes: 'Ajustare la soldul raportat de broker'
      });
      notify('success', 'Soldul a fost corectat.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Corectează soldul ${balance.currency} la ${balance.brokerName}${balance.portfolioName ? ` (${balance.portfolioName})` : ''}`}
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="adjust-form" loading={saving}>
            Salvează
          </Button>
        </>
      }
    >
      <form id="adjust-form" onSubmit={submit} className="space-y-3 text-sm text-ink-2">
        <p>
          Soldul calculat din tranzacții: <strong className="tabular text-ink">{money(balance.amount, balance.currency)}</strong>
        </p>
        <Field label={`Soldul real afișat de broker (${balance.currency})`}>
          <Input inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="0,00" autoFocus required />
        </Field>
        {diff !== null && diff !== 0 && (
          <p>
            Se va înregistra o ajustare de <strong className="tabular text-ink">{signedMoney(diff, balance.currency)}</strong>, cu data de azi.
          </p>
        )}
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}

function Help({ children }: { children: ReactNode }) {
  return (
    <details className="group mt-2 text-xs text-ink-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-accent">
        <CircleHelp className="size-3.5" aria-hidden /> Ce înseamnă?
      </summary>
      <div className="mt-1.5 space-y-1.5 leading-relaxed">{children}</div>
    </details>
  );
}

export function CashCards({
  totals,
  balances,
  untracked,
  performance,
  assets,
  onChanged
}: {
  totals: PortfolioTotals;
  balances: CashBalanceView[];
  untracked: string[];
  performance: PerformanceData | null;
  assets: Asset[];
  onChanged: () => void;
}) {
  const base = totals.baseCurrency;
  const { scope, activePortfolios } = useApp();
  const showPortfolio = scope === 'all' && activePortfolios.length > 1;
  const [adjusting, setAdjusting] = useState<CashBalanceView | null>(null);
  const [preset, setPreset] = useState<TransactionPreset | null>(null);
  const all = performance?.allTime;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card
        title="Cash disponibil"
        action={
          <IconButton label="Adaugă o depunere" onClick={() => setPreset({ type: 'deposit' })}>
            <Plus className="size-4" />
          </IconButton>
        }
      >
        <p className="tabular text-stat font-semibold text-ink">{money(totals.cash, base)}</p>
        {balances.length > 0 ? (
          <ul className="mt-2 space-y-1 text-body">
            {balances.map((b) => (
              <li key={`${b.portfolioId}:${b.brokerId}:${b.currency}`} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {b.brokerName}
                  {showPortfolio && b.portfolioName && <span className="text-ink-3"> · {b.portfolioName}</span>}
                </span>
                <span className={b.amount < 0 ? 'tabular font-medium text-loss' : 'tabular font-medium text-ink'}>{money(b.amount, b.currency)}</span>
                <IconButton label={`Corectează soldul ${b.currency} la ${b.brokerName}`} className="size-7" onClick={() => setAdjusting(b)}>
                  <SlidersHorizontal className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-ink-2">Înregistrează depunerile și retragerile (Tranzacții → Adaugă tranzacție → Depunere) ca aplicația să calculeze singură soldul de cash la fiecare broker.</p>
        )}
        {balances.some((b) => b.amount < 0) && (
          <p className="mt-2 text-xs text-loss">Un sold negativ înseamnă de regulă depuneri lipsă sau o conversie valutară neînregistrată. Corectează-l cu iconița de lângă sumă.</p>
        )}
        {untracked.length > 0 && balances.length > 0 && (
          <p className="mt-2 text-xs text-ink-3">Fără depuneri înregistrate (cash neurmărit): {untracked.join(', ')}.</p>
        )}
      </Card>

      <Card title="Total depus net vs. valoare actuală">
        {all ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body">
              <dt className="text-ink-2">Total depus net</dt>
              <dd className="tabular text-right font-medium text-ink">{money(all.netContributions, base)}</dd>
              <dt className="text-ink-2">Valoare actuală</dt>
              <dd className="tabular text-right font-medium text-ink">{money(all.currentValue, base)}</dd>
            </dl>
            <p className="mt-2 text-body text-ink-2">
              Investițiile au adus{' '}
              <Pnl value={all.gain} arrow className="text-base font-semibold">
                {signedMoney(all.gain, base)}
              </Pnl>{' '}
              peste banii puși.
            </p>
            {!performance?.cashTracked && (
              <p className="mt-1 text-xs text-ink-3">Estimat din cumpărări și vânzări, pentru că nu ai înregistrat depuneri. Adaugă-le pentru o cifră exactă.</p>
            )}
          </>
        ) : (
          <p className="text-body text-ink-3">Se calculează…</p>
        )}
      </Card>

      <Card title="Randament de la început">
        {performance && performance.twr !== null ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body">
              <dt className="text-ink-2" title="Randament ponderat în timp">
                TWR (investițiile)
              </dt>
              <dd className="text-right">
                <Pnl value={performance.twr} arrow className="font-semibold">
                  {signedPercent(performance.twr)}
                </Pnl>
                {performance.twrAnnualized !== null && <span className="block text-xs text-ink-3">{signedPercent(performance.twrAnnualized)} pe an</span>}
              </dd>
              <dt className="text-ink-2" title="Randament ponderat cu banii">
                XIRR (banii tăi)
              </dt>
              <dd className="text-right">
                {performance.xirr === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <Pnl value={performance.xirr} arrow className="font-semibold">
                    {signedPercent(performance.xirr)} pe an
                  </Pnl>
                )}
              </dd>
            </dl>
            <Help>
              <p>
                <strong className="text-ink">TWR</strong> arată cât de bine au mers investițiile, ca și cum ai fi pus toți banii de la început: depunerile noi nu îl umflă și nici nu îl
                strică. Este cifra potrivită pentru comparația cu un indice.
              </p>
              <p>
                <strong className="text-ink">XIRR</strong> arată randamentul anual efectiv al banilor tăi, ținând cont de când i-ai depus. Dacă ai depus mult chiar înaintea unei creșteri,
                XIRR iese mai mare decât TWR; dacă ai depus înaintea unei scăderi, mai mic.
              </p>
            </Help>
          </>
        ) : (
          <p className="text-body text-ink-3">Nu există încă suficiente date.</p>
        )}
      </Card>

      {adjusting && (
        <AdjustDialog
          balance={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            onChanged();
          }}
        />
      )}
      {preset && (
        <TransactionForm
          assets={assets}
          initial={null}
          preset={preset}
          onClose={() => setPreset(null)}
          onSaved={() => {
            setPreset(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
