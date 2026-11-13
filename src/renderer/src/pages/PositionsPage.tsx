/** Pagina Portofoliu: pozițiile deschise (agregat sau pe broker), adăugare de active, vânzare, editare, mutare între portofolii. */
import { Fragment, useState } from 'react';
import { ArrowLeftRight, ChevronRight, FolderInput, NotebookPen, Pencil, Plus, Trash2, TrendingDown, Wallet } from 'lucide-react';
import type { Asset, PositionView, TransactionType } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, price as fmtPrice, quantity as fmtQuantity, signedMoney, signedPercent } from '../lib/format';
import { AssetForm } from '../components/AssetForm';
import { PurchaseForm } from '../components/PurchaseForm';
import { TransactionForm } from '../components/TransactionForm';
import { ImportButton } from '../components/ImportButton';
import { MoveDialog, PortfolioTag } from '../components/portfolio';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, LoadError, Modal, Notice, PageSkeleton, Pnl, Segmented, TD, TH, cx } from '../components/ui';
import { TickerLogo } from '../components/TickerLogo';
import { JournalEntryForm } from '../components/journal';
import { AssetDetailModal, SymbolButton, type AssetRef } from '../components/AssetDetail';

type View = 'aggregated' | 'byBroker';

/** Prețul afișat: procent pentru obligațiuni, altfel valoare în moneda activului. */
const showPrice = (p: PositionView, value: number | null): string => (value === null ? '—' : p.assetType === 'bond' ? `${fmtPrice(value)}%` : fmtPrice(value));

/** Eticheta care explică de unde vine prețul curent, când nu este un preț din API. */
function PriceSource({ p }: { p: PositionView }) {
  if (p.priceSource === 'manual') return <span title={`Preț introdus manual${p.priceAsOf ? ` la ${fmtDate(p.priceAsOf)}` : ''}`}><Badge tone="accent">manual</Badge></span>;
  if (p.priceSource === 'cost') return <span title="Nu există un preț disponibil; poziția este evaluată la cost."><Badge tone="warn">la cost</Badge></span>;
  return null;
}

/** Profitul nerealizat în moneda de bază, cu împărțirea pe preț și curs valutar când moneda diferă. */
function PnlCell({ p, base }: { p: PositionView; base: string }) {
  const showFx = p.currency !== base && Math.abs(p.fxPnlBase) >= 0.005;
  return (
    <>
      <div>
        <Pnl value={p.unrealizedBase} className="font-medium">
          {signedMoney(p.unrealizedBase, base)}
        </Pnl>
      </div>
      <Pnl value={p.unrealizedBasePct} arrow className="text-xs">
        {signedPercent(p.unrealizedBasePct)}
      </Pnl>
      {showFx && (
        <div className="text-2xs text-ink-3" title="Profitul din evoluția prețului și cel din schimbarea cursului valutar de la cumpărare până azi">
          <div>preț {signedMoney(p.pricePnlBase, base)}</div>
          <div>curs {signedMoney(p.fxPnlBase, base)}</div>
        </div>
      )}
    </>
  );
}

/** Rândul de sub o poziție pe minus: cât pierde, prețul de break-even și cât trebuie să crească prețul. */
function LossDetails({ p, base }: { p: PositionView; base: string }) {
  const bePrice = p.breakEvenPrice === null ? '—' : showPrice(p, p.breakEvenPrice);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-loss-soft px-3 py-1.5 text-xs text-ink">
      <span className="inline-flex items-center gap-1 font-semibold text-loss">
        <TrendingDown className="size-3.5" aria-hidden />
        Pe minus cu {money(Math.abs(p.unrealizedBase), base)} ({signedPercent(p.unrealizedBasePct)})
      </span>
      <span title="Prețul la care poziția iese pe zero, cu tot cu comisioanele plătite">
        Break-even: <strong className="tabular">{bePrice}{p.assetType === 'bond' ? '' : ` ${p.currency}`}</strong>
        {p.currency !== base && <span className="text-ink-3"> (la cursul de azi)</span>}
      </span>
      {p.recoveryPct !== null && (
        <span>
          Ca să recuperezi, prețul trebuie să crească cu <strong className="tabular">{signedPercent(p.recoveryPct)}</strong>
        </span>
      )}
    </div>
  );
}

export function PositionsPage() {
  const { filter, dataVersion, bumpData, notify, activePortfolios, scope } = useApp();
  const [view, setView] = useState<View>('aggregated');
  const [purchase, setPurchase] = useState(false);
  const [journalFor, setJournalFor] = useState<{ assetId: number; portfolioId: number | null } | null>(null);
  const [txPreset, setTxPreset] = useState<{ type: TransactionType; assetId: number; brokerId?: number | null; portfolioId?: number | null } | null>(null);
  const [moving, setMoving] = useState<{ ids: number[]; position: PositionView } | null>(null);
  /** Știrile și raportările activului al cărui simbol a fost apăsat. */
  const [detail, setDetail] = useState<AssetRef | null>(null);
  const openDetail = (p: PositionView): void => setDetail({ symbol: p.symbol, name: p.name, type: p.assetType });
  /** În vederea combinată, fiecare linie pe broker arată și portofoliul. */
  const showPortfolio = scope === 'all' && activePortfolios.length > 1;

  const startMove = async (p: PositionView): Promise<void> => {
    if (p.portfolioId == null || p.brokerId == null) return;
    try {
      setMoving({ ids: await api.transactions.positionIds(p.portfolioId, p.assetId, p.brokerId), position: p });
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };
  const [editing, setEditing] = useState<Asset | null>(null);
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  /** Pe telefon: poziția atinsă, cu detaliile și acțiunile ei. */
  const [actionsFor, setActionsFor] = useState<PositionView | null>(null);

  const overview = useLoad(() => api.portfolio.overview(filter), [filter, dataVersion]);
  const assets = useLoad(() => api.assets.list(), [dataVersion]);
  const o = overview.data;
  const assetList = assets.data ?? [];
  const assetOf = (id: number): Asset | undefined => assetList.find((a) => a.id === id);

  const afterSave = (): void => {
    setPurchase(false);
    setTxPreset(null);
    setEditing(null);
    bumpData();
  };

  const removeAsset = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.assets.remove(deleting.id);
      notify('success', `${deleting.symbol} și tranzacțiile lui au fost șterse.`);
      setDeleting(null);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!o) {
    return overview.error ? <LoadError message={overview.error} onRetry={overview.reload} /> : <PageSkeleton />;
  }

  const base = o.totals.baseCurrency;
  const rows = view === 'aggregated' ? o.aggregated : o.positions;
  const byBroker = view === 'byBroker';

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'aggregated', label: 'Total pe activ' },
            { value: 'byBroker', label: 'Pe broker' }
          ]}
        />
        <p className="text-body text-ink-2">
          {rows.length} {rows.length === 1 ? 'poziție' : 'poziții'} · valoare <strong className="tabular text-ink">{money(o.totals.totalValue, base)}</strong> · nerealizat{' '}
          <Pnl value={o.totals.unrealized} className="font-semibold">
            {signedMoney(o.totals.unrealized, base)}
          </Pnl>
        </p>
        <div className="ml-auto flex gap-2">
          <ImportButton />
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPurchase(true)}>
            Adaugă activ
          </Button>
        </div>
      </div>

      {o.missingPrices.length > 0 && (
        <Notice tone="warn">
          Fără preț de piață pentru <strong>{o.missingPrices.join(', ')}</strong>. Apasă pe creion pentru a introduce un preț manual.
        </Notice>
      )}

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-5" />}
            title="Nicio poziție deschisă"
            text="Adaugă un activ cumpărat: tip, simbol, număr de unități, preț, dată și broker. Dacă ai cont la XTB, alege fișierul Excel exportat din xStation și pozițiile apar singure."
            action={
              <div className="flex gap-2">
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPurchase(true)}>
                  Adaugă activ
                </Button>
                <ImportButton />
              </div>
            }
          />
        ) : (
          <>
          {/* Pe telefon: un rând pe poziție (logo, nume, valoare, profit); atingerea deschide acțiunile. */}
          <ul className="divide-y divide-line md:hidden">
            {rows.map((p) => (
              <li key={p.key}>
                <div className="flex min-h-16 w-full items-stretch">
                  {/* Stânga: știrile și raportările activului; dreapta: acțiunile poziției. */}
                  <button type="button" onClick={() => openDetail(p)} aria-label={`Știri și raportări pentru ${p.symbol}`} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left">
                    <TickerLogo symbol={p.symbol} type={p.assetType} size={36} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-semibold text-ink">
                        {p.symbol}
                        {byBroker && <span className="font-normal text-ink-3"> · {p.brokerName}</span>}
                      </p>
                      <p className="truncate text-xs text-ink-3">{p.name || ASSET_TYPE_LABEL[p.assetType]}</p>
                    </div>
                  </button>
                  <button type="button" onClick={() => setActionsFor(p)} aria-label={`Acțiuni pentru ${p.symbol}`} className="flex shrink-0 items-center gap-1 py-3 pr-3 pl-3 text-right">
                    <span>
                      <span className="block text-body font-semibold text-ink">{money(p.marketValueBase, base)}</span>
                      <Pnl value={p.unrealizedBase} className="text-xs font-medium">
                        {signedMoney(p.unrealizedBase, base)} ({signedPercent(p.unrealizedBasePct)})
                      </Pnl>
                    </span>
                    <ChevronRight className="size-4 text-ink-3" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH}>Activ</th>
                  {byBroker && <th className={TH}>Broker</th>}
                  <th className={cx(TH, 'text-right')}>Cantitate</th>
                  <th className={cx(TH, 'text-right')}>Preț mediu</th>
                  <th className={cx(TH, 'text-right')}>Preț curent</th>
                  <th className={cx(TH, 'text-right')}>Valoare de piață</th>
                  <th className={cx(TH, 'text-right')} title={`Profit nerealizat în ${base}: din preț și din cursul valutar`}>Profit / pierdere</th>
                  <th className={cx(TH, 'text-right')} title={`Profit din vânzări + dividende și cupoane, în ${base}`}>Realizat</th>
                  <th className={TH} aria-label="Acțiuni" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const asset = assetOf(p.assetId);
                  const realized = p.realizedBase + p.incomeBase;
                  const losing = p.unrealizedBase <= -0.005;
                  return (
                    <Fragment key={p.key}>
                    <tr className={cx('border-line hover:bg-surface-2/60', losing ? '' : 'border-b last:border-0')}>
                      <td className={TD}>
                        <div className="flex items-center gap-2.5">
                          <TickerLogo symbol={p.symbol} type={p.assetType} size={30} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <SymbolButton symbol={p.symbol} onClick={() => openDetail(p)} />
                              <Badge>{ASSET_TYPE_LABEL[p.assetType]}</Badge>
                            </div>
                            <div className="max-w-48 truncate text-xs text-ink-3" title={p.name}>{p.name || '—'}</div>
                          </div>
                        </div>
                      </td>
                      {byBroker && (
                        <td className={TD}>
                          {p.brokerName}
                          {showPortfolio && (
                            <div>
                              <PortfolioTag portfolioId={p.portfolioId} />
                            </div>
                          )}
                        </td>
                      )}
                      <td className={cx(TD, 'tabular text-right')}>{fmtQuantity(p.quantity)}</td>
                      <td className={cx(TD, 'tabular text-right')}>{showPrice(p, p.avgPrice)}</td>
                      <td className={cx(TD, 'tabular text-right')}>
                        <div className="flex items-center justify-end gap-1.5">
                          <PriceSource p={p} />
                          {showPrice(p, p.price)}
                        </div>
                      </td>
                      <td className={cx(TD, 'tabular text-right')}>
                        <div className="font-medium">{money(p.marketValue, p.currency)}</div>
                        {p.currency !== base && <div className="text-xs text-ink-3">{money(p.marketValueBase, base)}</div>}
                      </td>
                      <td className={cx(TD, 'text-right')}>
                        <PnlCell p={p} base={base} />
                      </td>
                      <td className={cx(TD, 'text-right')}>
                        <Pnl value={realized}>{Math.abs(realized) < 0.005 ? '—' : signedMoney(realized, base)}</Pnl>
                      </td>
                      <td className={cx(TD, 'text-right')}>
                        <div className="flex justify-end">
                          <IconButton
                            label={`Vinde ${p.symbol}`}
                            onClick={() => setTxPreset({ type: 'sell', assetId: p.assetId, brokerId: p.brokerId ?? undefined, portfolioId: p.portfolioId })}
                          >
                            <ArrowLeftRight className="size-4" />
                          </IconButton>
                          <IconButton label={`Notează în jurnal despre ${p.symbol}`} onClick={() => setJournalFor({ assetId: p.assetId, portfolioId: p.portfolioId })}>
                            <NotebookPen className="size-4" />
                          </IconButton>
                          {byBroker && activePortfolios.length > 1 && p.portfolioId != null && (
                            <IconButton label={`Mută ${p.symbol} în alt portofoliu`} onClick={() => void startMove(p)}>
                              <FolderInput className="size-4" />
                            </IconButton>
                          )}
                          <IconButton label={`Editează ${p.symbol} (preț manual, detalii)`} disabled={!asset} onClick={() => asset && setEditing(asset)}>
                            <Pencil className="size-4" />
                          </IconButton>
                          <IconButton label={`Șterge ${p.symbol}`} disabled={!asset} onClick={() => asset && setDeleting(asset)}>
                            <Trash2 className="size-4" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                    {losing && (
                      <tr className="border-b border-line last:border-0">
                        <td colSpan={byBroker ? 9 : 8} className="px-3 pb-2.5">
                          <LossDetails p={p} base={base} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {actionsFor &&
        (() => {
          const p = actionsFor;
          const asset = assetOf(p.assetId);
          const then = (fn: () => void) => (): void => {
            setActionsFor(null);
            fn();
          };
          return (
            <Modal title={`${p.symbol}${byBroker ? ` · ${p.brokerName}` : ''}`} onClose={() => setActionsFor(null)}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body">
                <div>
                  <dt className="text-xs text-ink-3">Cantitate</dt>
                  <dd className="font-medium text-ink">{fmtQuantity(p.quantity)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Valoare de piață</dt>
                  <dd className="font-medium text-ink">{money(p.marketValue, p.currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Preț mediu</dt>
                  <dd className="font-medium text-ink">{showPrice(p, p.avgPrice)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Preț curent</dt>
                  <dd className="flex items-center gap-1.5 font-medium text-ink">
                    {showPrice(p, p.price)} <PriceSource p={p} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Profit / pierdere</dt>
                  <dd>
                    <PnlCell p={p} base={base} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Realizat</dt>
                  <dd>
                    <Pnl value={p.realizedBase + p.incomeBase}>{Math.abs(p.realizedBase + p.incomeBase) < 0.005 ? '—' : signedMoney(p.realizedBase + p.incomeBase, base)}</Pnl>
                  </dd>
                </div>
              </dl>
              {p.unrealizedBase <= -0.005 && (
                <div className="mt-3">
                  <LossDetails p={p} base={base} />
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button icon={<ArrowLeftRight className="size-4" />} onClick={then(() => setTxPreset({ type: 'sell', assetId: p.assetId, brokerId: p.brokerId ?? undefined, portfolioId: p.portfolioId }))}>
                  Vinde
                </Button>
                <Button icon={<NotebookPen className="size-4" />} onClick={then(() => setJournalFor({ assetId: p.assetId, portfolioId: p.portfolioId }))}>
                  Jurnal
                </Button>
                {byBroker && activePortfolios.length > 1 && p.portfolioId != null && (
                  <Button icon={<FolderInput className="size-4" />} onClick={then(() => void startMove(p))}>
                    Mută
                  </Button>
                )}
                <Button icon={<Pencil className="size-4" />} disabled={!asset} onClick={then(() => asset && setEditing(asset))}>
                  Editează
                </Button>
                <Button variant="danger" icon={<Trash2 className="size-4" />} disabled={!asset} onClick={then(() => asset && setDeleting(asset))}>
                  Șterge
                </Button>
              </div>
            </Modal>
          );
        })()}

      {o.closed.length > 0 && (
        <Card title="Poziții închise" padded={false}>
          <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={TH}>Activ</th>
                <th className={cx(TH, 'text-right')}>Total cumpărat</th>
                <th className={cx(TH, 'text-right')}>Profit din vânzări</th>
                <th className={cx(TH, 'text-right')}>Dividende / cupoane</th>
                <th className={cx(TH, 'text-right')}>Profit realizat</th>
              </tr>
            </thead>
            <tbody>
              {o.closed.map((p) => (
                <tr key={p.key} className="border-b border-line last:border-0">
                  <td className={TD}>
                    <span className="flex items-center gap-2">
                      <TickerLogo symbol={p.symbol} type={p.assetType} size={22} />
                      <span className="font-semibold">{p.symbol}</span> <span className="truncate text-ink-3">{p.name}</span>
                    </span>
                  </td>
                  <td className={cx(TD, 'tabular text-right')}>{money(p.totalBought, p.currency)}</td>
                  <td className={cx(TD, 'text-right')}>
                    <Pnl value={p.realizedPnl}>{signedMoney(p.realizedPnl, p.currency)}</Pnl>
                  </td>
                  <td className={cx(TD, 'tabular text-right')}>{money(p.income, p.currency)}</td>
                  <td className={cx(TD, 'text-right')}>
                    <Pnl value={p.realizedPnl + p.income} className="font-medium">
                      {signedMoney(p.realizedPnl + p.income, p.currency)}
                    </Pnl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {detail && <AssetDetailModal asset={detail} onClose={() => setDetail(null)} />}
      {purchase && <PurchaseForm assets={assetList} onClose={() => setPurchase(false)} onSaved={afterSave} />}
      {journalFor && (
        <JournalEntryForm
          entry={null}
          preset={journalFor}
          assets={assetList}
          onClose={() => setJournalFor(null)}
          onSaved={() => {
            setJournalFor(null);
            afterSave();
          }}
        />
      )}
      {txPreset && <TransactionForm assets={assetList} initial={null} preset={txPreset} onClose={() => setTxPreset(null)} onSaved={afterSave} />}
      {editing && <AssetForm asset={editing} onClose={() => setEditing(null)} onSaved={afterSave} />}
      {moving && (
        <MoveDialog
          ids={moving.ids}
          fromPortfolioId={moving.position.portfolioId}
          title={`Mută ${moving.position.symbol} (${moving.position.brokerName ?? ''}) în alt portofoliu`}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null);
            bumpData();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Ștergi ${deleting.symbol}?`}
          message={
            <>
              Activul <strong className="text-ink">{deleting.symbol}</strong> va fi șters împreună cu <strong className="text-ink">toate tranzacțiile lui</strong> (cumpărări, vânzări, dividende). Operațiunea nu poate fi anulată.
            </>
          }
          confirmLabel="Șterge activul"
          busy={busy}
          onConfirm={() => void removeAsset()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
