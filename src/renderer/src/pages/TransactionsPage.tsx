/** Istoricul tranzacțiilor: tabel cu filtre, adăugare, editare, ștergere, import și export CSV. */
import { useState, useEffect, useMemo } from 'react';
import { ArrowLeftRight, FileDown, Pencil, Plus, RotateCcw, Trash2, FolderInput } from 'lucide-react';
import {
  ASSET_TYPES,
  TRANSACTION_TYPES,
  type Asset,
  type AssetType,
  type TransactionFilters,
  type TransactionType,
  type TransactionView
} from '@shared/types';
import { ASSET_TYPE_LABEL, ASSET_TYPE_LABEL_PLURAL, TRANSACTION_TYPE_LABEL } from '@shared/labels';
import { priceMultiplier } from '@shared/calc/valuation';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, price as fmtPrice, quantity as fmtQuantity, signedMoney } from '../lib/format';
import { TransactionForm } from '../components/TransactionForm';
import { ImportButton } from '../components/ImportButton';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, ListSkeleton, LoadError, Notice, Select, TD, TH, cx } from '../components/ui';
import { MoveDialog, PortfolioTag } from '../components/portfolio';
import { TickerLogo } from '../components/TickerLogo';

const TYPE_TONE: Record<TransactionType, 'accent' | 'warn' | 'gain' | 'loss' | 'neutral'> = {
  buy: 'accent',
  sell: 'warn',
  dividend: 'gain',
  coupon: 'gain',
  split: 'neutral',
  deposit: 'gain',
  withdrawal: 'warn',
  fee: 'loss',
  interest: 'gain',
  adjustment: 'neutral'
};

/** Valoarea tranzacției în moneda ei: cantitate × preț pentru cumpărări/vânzări, suma pentru celelalte. */
function amountOf(t: TransactionView, asset: Asset | undefined): string {
  if (t.type === 'split') return '—';
  if (t.type === 'withdrawal' || t.type === 'fee') return `−${money(t.netAmount, t.currency)}`;
  if (t.type === 'adjustment') return signedMoney(t.netAmount, t.currency);
  if (t.type !== 'buy' && t.type !== 'sell') return money(t.netAmount, t.currency);
  const multiplier = asset ? priceMultiplier(asset) : 1;
  return money(t.quantity * t.price * multiplier, t.currency);
}

export function TransactionsPage() {
  const { brokers, dataVersion, bumpData, notify, scope, activePortfolios } = useApp();
  const [filters, setFilters] = useState<TransactionFilters>({});
  /** Filtrele alese pe pagină, plus portofoliul selectat în bara de sus. */
  const scoped = useMemo<TransactionFilters>(() => ({ ...filters, portfolioId: scope === 'all' ? null : scope }), [filters, scope]);
  const canMove = activePortfolios.length > 1;
  const showPortfolio = scope === 'all' && canMove;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [moving, setMoving] = useState(false);
  const [form, setForm] = useState<{ initial: TransactionView | null } | null>(null);
  const [deleting, setDeleting] = useState<TransactionView | null>(null);
  const [busy, setBusy] = useState<'delete' | 'export' | null>(null);

  const list = useLoad(() => api.transactions.list(scoped), [scoped, dataVersion]);
  // Selecția se golește când se schimbă lista (filtre, portofoliu, date noi).
  useEffect(() => setSelected(new Set()), [scoped, dataVersion]);
  const assets = useLoad(() => api.assets.list(), [dataVersion]);
  const assetList = assets.data ?? [];
  const rows = list.data ?? [];
  const hasFilters = Object.values(filters).some((v) => v !== undefined && v !== null && v !== '');

  const patch = (p: Partial<TransactionFilters>): void => setFilters((f) => ({ ...f, ...p }));

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy('delete');
    try {
      await api.transactions.remove(deleting.id);
      notify('success', 'Tranzacția a fost ștearsă.');
      setDeleting(null);
      bumpData();
    } catch (err) {
      // De regulă: ștergerea unei cumpărări ar lăsa o vânzare ulterioară fără acoperire.
      notify('error', errorMessage(err));
      setDeleting(null);
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async (): Promise<void> => {
    setBusy('export');
    try {
      const res = await api.transactions.exportCsv(scoped);
      if (!res.canceled) notify('success', `${res.count} tranzacții exportate în ${res.path}.`);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Tip tranzacție
          <Select className="w-36!" value={filters.type ?? ''} onChange={(e) => patch({ type: (e.target.value || null) as TransactionType | null })}>
            <option value="">Toate</option>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TRANSACTION_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Tip activ
          <Select className="w-36!" value={filters.assetType ?? ''} onChange={(e) => patch({ assetType: (e.target.value || null) as AssetType | null })}>
            <option value="">Toate</option>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>
                {ASSET_TYPE_LABEL_PLURAL[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Simbol
          <Input className="w-32! uppercase placeholder:normal-case" value={filters.symbol ?? ''} onChange={(e) => patch({ symbol: e.target.value })} placeholder="ex.: AAPL" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Broker
          <Select className="w-36!" value={filters.brokerId ?? ''} onChange={(e) => patch({ brokerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Toți</option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          De la
          <Input type="date" className="w-38!" value={filters.dateFrom ?? ''} onChange={(e) => patch({ dateFrom: e.target.value || null })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Până la
          <Input type="date" className="w-38!" value={filters.dateTo ?? ''} onChange={(e) => patch({ dateTo: e.target.value || null })} />
        </label>
        {hasFilters && (
          <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setFilters({})}>
            Resetează
          </Button>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {selected.size > 0 && (
            <Button icon={<FolderInput className="size-4" />} onClick={() => setMoving(true)}>
              Mută {selected.size === 1 ? 'tranzacția' : `${selected.size} tranzacții`}
            </Button>
          )}
          <ImportButton />
          <Button icon={<FileDown className="size-4" />} loading={busy === 'export'} disabled={rows.length === 0} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ initial: null })}>
            Adaugă tranzacție
          </Button>
        </div>
      </div>

      {list.error && <Notice tone="loss">{list.error}</Notice>}

      <Card padded={false}>
        {list.error ? (
          <div className="p-4">
            <LoadError message={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <ListSkeleton rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight className="size-5" />}
            title={hasFilters ? 'Nicio tranzacție pentru filtrele alese' : 'Nicio tranzacție încă'}
            text={hasFilters ? 'Schimbă sau resetează filtrele.' : 'Achizițiile adăugate în pagina Portofoliu apar aici automat. Tot aici înregistrezi vânzări, dividende, cupoane și split-uri sau imporți fișierul Excel exportat din xStation (XTB).'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  {canMove && (
                    <th className={cx(TH, 'w-8 pr-0')}>
                      <input
                        type="checkbox"
                        aria-label="Selectează toate tranzacțiile afișate"
                        className="size-4 accent-accent"
                        checked={selected.size > 0 && selected.size === rows.filter((r) => r.type !== 'split').length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.filter((r) => r.type !== 'split').map((r) => r.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th className={TH}>Data</th>
                  <th className={TH}>Tip</th>
                  <th className={TH}>Activ</th>
                  <th className={TH}>Broker</th>
                  <th className={cx(TH, 'text-right')}>Cantitate</th>
                  <th className={cx(TH, 'text-right')}>Preț</th>
                  <th className={cx(TH, 'text-right')}>Comision</th>
                  <th className={cx(TH, 'text-right')}>Valoare</th>
                  <th className={TH}>Note</th>
                  <th className={TH} aria-label="Acțiuni" />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const asset = assetList.find((a) => a.id === t.assetId);
                  const trade = t.type === 'buy' || t.type === 'sell';
                  return (
                    <tr key={t.id} className={cx('border-b border-line last:border-0 hover:bg-surface-2/60', selected.has(t.id) && 'bg-accent-soft/60')}>
                      {canMove && (
                        <td className={cx(TD, 'w-8 pr-0')}>
                          {t.type !== 'split' && (
                            <input
                              type="checkbox"
                              aria-label={`Selectează tranzacția din ${fmtDate(t.date)}`}
                              className="size-4 accent-accent"
                              checked={selected.has(t.id)}
                              onChange={(e) =>
                                setSelected((s) => {
                                  const next = new Set(s);
                                  if (e.target.checked) next.add(t.id);
                                  else next.delete(t.id);
                                  return next;
                                })
                              }
                            />
                          )}
                        </td>
                      )}
                      <td className={cx(TD, 'tabular')}>{fmtDate(t.date)}</td>
                      <td className={TD}>
                        <Badge tone={TYPE_TONE[t.type]}>{TRANSACTION_TYPE_LABEL[t.type]}</Badge>
                      </td>
                      <td className={TD}>
                        {t.symbol ? (
                          <span className="flex items-center gap-2">
                            {t.assetType && <TickerLogo symbol={t.symbol} type={t.assetType} size={22} />}
                            <span className="font-semibold">{t.symbol}</span> {t.assetType && <span className="text-xs text-ink-3">{ASSET_TYPE_LABEL[t.assetType]}</span>}
                          </span>
                        ) : (
                          <span className="text-ink-2">Cash {t.currency}</span>
                        )}
                      </td>
                      <td className={TD}>
                        {t.brokerName ?? <span className="text-ink-3">Toți brokerii</span>}
                        {showPortfolio && t.portfolioId != null && (
                          <div>
                            <PortfolioTag portfolioId={t.portfolioId} />
                          </div>
                        )}
                      </td>
                      <td className={cx(TD, 'tabular text-right')}>{trade ? fmtQuantity(t.quantity) : t.type === 'split' ? `${t.splitNumerator}:${t.splitDenominator}` : '—'}</td>
                      <td className={cx(TD, 'tabular text-right')}>{trade ? `${fmtPrice(t.price)}${t.assetType === 'bond' ? '%' : ''}` : '—'}</td>
                      <td className={cx(TD, 'tabular text-right')}>{trade && t.fee > 0 ? money(t.fee, t.currency) : '—'}</td>
                      <td className={cx(TD, 'tabular text-right')}>
                        <div className="font-medium">{amountOf(t, asset)}</div>
                        {(t.type === 'dividend' || t.type === 'coupon' || t.type === 'interest') && (
                          <div className="text-xs text-ink-3">
                            brut {money(t.grossAmount, t.currency)} · impozit {money(t.taxWithheld, t.currency)}
                          </div>
                        )}
                      </td>
                      <td className={cx(TD, 'max-w-48 truncate text-ink-2')} title={t.notes ?? undefined}>
                        {t.notes ?? ''}
                      </td>
                      <td className={cx(TD, 'text-right')}>
                        <div className="flex justify-end">
                          <IconButton label="Editează tranzacția" onClick={() => setForm({ initial: t })}>
                            <Pencil className="size-4" />
                          </IconButton>
                          <IconButton label="Șterge tranzacția" onClick={() => setDeleting(t)}>
                            <Trash2 className="size-4" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {rows.length > 0 && <p className="text-xs text-ink-3">{rows.length === 1 ? '1 tranzacție afișată.' : `${rows.length} tranzacții afișate.`}</p>}

      {form && (
        <TransactionForm
          assets={assetList}
          initial={form.initial}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            bumpData();
          }}
        />
      )}
      {moving && (
        <MoveDialog
          ids={[...selected]}
          fromPortfolioId={scope === 'all' ? null : scope}
          title={selected.size === 1 ? 'Mută tranzacția în alt portofoliu' : `Mută ${selected.size} tranzacții în alt portofoliu`}
          onClose={() => setMoving(false)}
          onMoved={() => {
            setMoving(false);
            setSelected(new Set());
            bumpData();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Ștergi tranzacția?"
          message={
            <>
              {TRANSACTION_TYPE_LABEL[deleting.type]} {deleting.symbol} din {fmtDate(deleting.date)}. Pozițiile și profitul se recalculează automat.
            </>
          }
          busy={busy === 'delete'}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
