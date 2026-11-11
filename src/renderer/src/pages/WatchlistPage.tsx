/**
 * Watchlist: instrumente urmărite fără să fie deținute, în mai multe liste
 * (ex.: „De cumpărat”, „Dividende”). Pentru fiecare: logo, preț, variația de azi,
 * graficul pe trei luni, prețul țintă de cumpărare și o notă. Din listă se poate
 * adăuga direct o cumpărare; instrumentul trece astfel în portofoliu.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, Pencil, Plus, Search, ShoppingCart, Trash2 } from 'lucide-react';
import { ASSET_CURRENCIES, ASSET_TYPES, type AssetType, type SymbolSearchResult, type Watchlist, type WatchlistItemView } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { parseNumberLoose } from '@shared/csv';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { dateTime, percent, price as fmtPrice, signedPercent } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, LoadError, Modal, Notice, PageSkeleton, Pnl, Segmented, Select, Spinner, TD, Textarea, TH, cx } from '../components/ui';
import { TickerLogo } from '../components/TickerLogo';
import { Sparkline } from '../components/Sparkline';
import { PurchaseForm } from '../components/PurchaseForm';

type SortKey = 'manual' | 'symbol' | 'change' | 'target';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'manual', label: 'Ordinea mea' },
  { value: 'symbol', label: 'Simbol' },
  { value: 'change', label: 'Variația de azi' },
  { value: 'target', label: 'Aproape de țintă' }
];
const SORT_KEY = 'portofoliu.watchlist.sort';
const LIST_KEY = 'portofoliu.watchlist.list';

const readPref = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // preferință opțională
  }
};

function sortItems(items: WatchlistItemView[], key: SortKey): WatchlistItemView[] {
  const list = [...items];
  const nullsLast = (a: number | null, b: number | null, dir = 1): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : (a - b) * dir);
  if (key === 'symbol') list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  else if (key === 'change') list.sort((a, b) => nullsLast(a.changePct, b.changePct, -1));
  else if (key === 'target') list.sort((a, b) => nullsLast(a.toTargetPct, b.toTargetPct));
  return list;
}

export function WatchlistPage() {
  const { notify, dataVersion, bumpData } = useApp();
  const lists = useLoad(() => api.watchlists.list(), [dataVersion]);
  const assets = useLoad(() => api.assets.list(), [dataVersion]);
  const [listId, setListId] = useState<number | null>(() => Number(readPref(LIST_KEY)) || null);
  const current = lists.data?.find((w) => w.id === listId) ?? lists.data?.[0] ?? null;
  const items = useLoad(() => (current ? api.watchlists.items(current.id) : Promise.resolve([])), [current?.id, dataVersion]);
  const [sort, setSort] = useState<SortKey>(() => (SORTS.some((s) => s.value === readPref(SORT_KEY)) ? (readPref(SORT_KEY) as SortKey) : 'manual'));
  const [editing, setEditing] = useState<WatchlistItemView | null>(null);
  const [removing, setRemoving] = useState<WatchlistItemView | null>(null);
  const [buying, setBuying] = useState<WatchlistItemView | null>(null);
  const [removeAfterBuy, setRemoveAfterBuy] = useState(true);
  const [listDialog, setListDialog] = useState<{ mode: 'create' | 'rename'; name: string } | null>(null);
  const [deletingList, setDeletingList] = useState<Watchlist | null>(null);

  useEffect(() => {
    if (current) writePref(LIST_KEY, String(current.id));
  }, [current]);

  const rows = useMemo(() => sortItems(items.data ?? [], sort), [items.data, sort]);
  const reached = rows.filter((i) => i.toTargetPct !== null && i.toTargetPct <= 0);

  const run = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
    try {
      await action();
      if (success) notify('success', success);
      lists.reload();
      items.reload();
      return true;
    } catch (err) {
      notify('error', errorMessage(err));
      return false;
    }
  };

  const move = (item: WatchlistItemView, dir: -1 | 1): void => {
    const ids = (items.data ?? []).map((i) => i.id);
    const at = ids.indexOf(item.id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    void run(() => api.watchlists.reorderItems(current!.id, ids));
  };

  const moveList = (dir: -1 | 1): void => {
    if (!lists.data || !current) return;
    const ids = lists.data.map((w) => w.id);
    const at = ids.indexOf(current.id);
    const to = at + dir;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    void run(() => api.watchlists.reorder(ids));
  };

  const saveList = async (): Promise<void> => {
    if (!listDialog) return;
    const ok = await run(async () => {
      const saved = listDialog.mode === 'create' ? await api.watchlists.create(listDialog.name) : await api.watchlists.rename(current!.id, listDialog.name);
      setListId(saved.id);
    });
    if (ok) setListDialog(null);
  };

  if (!lists.data) return lists.error ? <LoadError message={lists.error} onRetry={lists.reload} /> : <PageSkeleton />;

  return (
    <>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3" role="tablist" aria-label="Listele din watchlist">
          {lists.data.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === current?.id}
              onClick={() => setListId(w.id)}
              className={cx(
                'rounded-full border px-3 py-1 text-body font-medium transition-colors',
                w.id === current?.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'
              )}
            >
              {w.name} <span className="ml-0.5 text-xs opacity-70">{w.itemCount}</span>
            </button>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setListDialog({ mode: 'create', name: '' })}>
            Listă nouă
          </Button>
          {current && (
            <div className="ml-auto flex items-center gap-1">
              <IconButton label={`Mută lista „${current.name}” la stânga`} disabled={lists.data[0]?.id === current.id} onClick={() => moveList(-1)}>
                <ArrowUp className="size-4 -rotate-90" />
              </IconButton>
              <IconButton label={`Mută lista „${current.name}” la dreapta`} disabled={lists.data[lists.data.length - 1]?.id === current.id} onClick={() => moveList(1)}>
                <ArrowDown className="size-4 -rotate-90" />
              </IconButton>
              <IconButton label={`Redenumește lista „${current.name}”`} onClick={() => setListDialog({ mode: 'rename', name: current.name })}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton label={`Șterge lista „${current.name}”`} disabled={lists.data.length < 2} onClick={() => setDeletingList(current)}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          )}
        </div>

        {current && <AddSymbol watchlistId={current.id} onAdded={() => run(async () => undefined)} />}

        {reached.length > 0 && (
          <div className="px-4 pb-3">
            <Notice tone="accent">
              Prețul țintă a fost atins pentru <strong>{reached.map((i) => i.symbol).join(', ')}</strong>.
            </Notice>
          </div>
        )}

        {items.data && items.data.length === 0 ? (
          <div className="px-4 pb-6">
            <EmptyState
              icon={<Eye className="size-6" />}
              title="Lista este goală"
              text="Caută mai sus un simbol (acțiune, ETF, crypto) ca să-l urmărești: vezi prețul, variația de azi și cât mai e până la prețul la care ai vrea să cumperi."
            />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 px-4 pb-2">
              <Segmented
                size="sm"
                value={sort}
                onChange={(s) => {
                  setSort(s);
                  writePref(SORT_KEY, s);
                }}
                options={SORTS}
              />
              {items.loading && <Spinner className="size-4" />}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-y border-line">
                    <th className={TH}>Instrument</th>
                    <th className={cx(TH, 'text-right')}>Preț</th>
                    <th className={cx(TH, 'text-right')}>Azi</th>
                    <th className={TH}>3 luni</th>
                    <th className={cx(TH, 'text-right')}>Preț țintă</th>
                    <th className={TH}>Notă</th>
                    <th className={TH} aria-label="Acțiuni" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item, index) => {
                    const atTarget = item.toTargetPct !== null && item.toTargetPct <= 0;
                    return (
                      <tr key={item.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                        <td className={TD}>
                          <div className="flex items-center gap-2.5">
                            <TickerLogo symbol={item.symbol} type={item.type} size={30} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold">{item.symbol}</span>
                                {item.held && <Badge tone="accent">În portofoliu</Badge>}
                              </div>
                              <div className="max-w-56 truncate text-xs text-ink-3" title={item.name}>
                                {item.name || ASSET_TYPE_LABEL[item.type]}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className={cx(TD, 'tabular text-right')} title={item.priceAsOf ? `Actualizat: ${dateTime(item.priceAsOf)}` : undefined}>
                          {item.price === null ? <span className="text-ink-3">—</span> : `${fmtPrice(item.price)} ${item.currency}`}
                        </td>
                        <td className={cx(TD, 'text-right')}>
                          {item.changePct === null ? (
                            <span className="text-ink-3">—</span>
                          ) : (
                            <Pnl value={item.changePct} arrow className="justify-end font-medium">
                              {signedPercent(item.changePct)}
                            </Pnl>
                          )}
                        </td>
                        <td className={TD}>
                          <Sparkline points={item.sparkline} label={`${item.symbol}, ultimele 3 luni`} />
                        </td>
                        <td className={cx(TD, 'tabular text-right')}>
                          {item.targetPrice === null ? (
                            <span className="text-ink-3">—</span>
                          ) : (
                            <>
                              <div>
                                {fmtPrice(item.targetPrice)} {item.currency}
                              </div>
                              {item.toTargetPct !== null && (
                                <div className={cx('text-xs', atTarget ? 'font-semibold text-gain' : 'text-ink-3')}>
                                  {atTarget ? 'țintă atinsă' : `încă −${percent(item.toTargetPct / (1 + item.toTargetPct), 1)}`}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td className={cx(TD, 'max-w-56 truncate text-ink-2')} title={item.note ?? undefined}>
                          {item.note ?? ''}
                        </td>
                        <td className={cx(TD, 'text-right')}>
                          <div className="flex items-center justify-end gap-0.5">
                            <Button size="sm" variant="ghost" icon={<ShoppingCart className="size-4" />} onClick={() => setBuying(item)}>
                              Cumpără
                            </Button>
                            {sort === 'manual' && (
                              <>
                                <IconButton label={`Mută ${item.symbol} mai sus`} disabled={index === 0} onClick={() => move(item, -1)}>
                                  <ArrowUp className="size-4" />
                                </IconButton>
                                <IconButton label={`Mută ${item.symbol} mai jos`} disabled={index === rows.length - 1} onClick={() => move(item, 1)}>
                                  <ArrowDown className="size-4" />
                                </IconButton>
                              </>
                            )}
                            <IconButton label={`Editează ${item.symbol} (preț țintă, notă, listă)`} onClick={() => setEditing(item)}>
                              <Pencil className="size-4" />
                            </IconButton>
                            <IconButton label={`Scoate ${item.symbol} din listă`} onClick={() => setRemoving(item)}>
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
            <p className="px-4 py-2.5 text-xs text-ink-3">Prețurile se actualizează odată cu ale portofoliului; variația de azi este față de închiderea anterioară.</p>
          </>
        )}
      </Card>

      {editing && lists.data && (
        <EditItem
          item={editing}
          lists={lists.data}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            if (await run(() => api.watchlists.updateItem(editing.id, patch), `${editing.symbol} a fost actualizat.`)) setEditing(null);
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Scoți ${removing.symbol} din listă?`}
          confirmLabel="Scoate din listă"
          message={<>Instrumentul nu mai apare în „{current?.name}”. Tranzacțiile și pozițiile din portofoliu nu sunt atinse.</>}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void run(() => api.watchlists.removeItem(removing.id)).then(() => setRemoving(null))}
        />
      )}

      {deletingList && (
        <ConfirmDialog
          title={`Ștergi lista „${deletingList.name}”?`}
          confirmLabel="Șterge lista"
          message={<>Se șterge lista cu toate instrumentele urmărite din ea ({deletingList.itemCount}). Portofoliul nu este atins.</>}
          onCancel={() => setDeletingList(null)}
          onConfirm={() =>
            void run(() => api.watchlists.remove(deletingList.id), `Lista „${deletingList.name}” a fost ștearsă.`).then(() => {
              setDeletingList(null);
              setListId(null);
            })
          }
        />
      )}

      {listDialog && (
        <Modal
          title={listDialog.mode === 'create' ? 'Listă nouă' : 'Redenumește lista'}
          width="max-w-sm"
          onClose={() => setListDialog(null)}
          footer={
            <>
              <Button onClick={() => setListDialog(null)}>Renunță</Button>
              <Button variant="primary" type="submit" form="watchlist-name" disabled={!listDialog.name.trim()}>
                Salvează
              </Button>
            </>
          }
        >
          <form
            id="watchlist-name"
            onSubmit={(e) => {
              e.preventDefault();
              void saveList();
            }}
          >
            <Field label="Numele listei">
              <Input value={listDialog.name} onChange={(e) => setListDialog({ ...listDialog, name: e.target.value })} maxLength={40} placeholder="ex.: De cumpărat, Dividende" autoFocus />
            </Field>
          </form>
        </Modal>
      )}

      {buying && assets.data && (
        <PurchaseForm
          assets={assets.data}
          preset={{ type: buying.type, symbol: buying.symbol, name: buying.name, currency: buying.currency }}
          extraOption={{ label: `Scoate ${buying.symbol} din „${current?.name}” după cumpărare`, checked: removeAfterBuy, onChange: setRemoveAfterBuy }}
          onClose={() => setBuying(null)}
          onSaved={() => {
            const item = buying;
            setBuying(null);
            if (removeAfterBuy) void run(() => api.watchlists.removeItem(item.id));
            bumpData();
          }}
        />
      )}
    </>
  );
}

/* ----------------------------------------------------- adăugarea unui simbol */

function AddSymbol({ watchlistId, onAdded }: { watchlistId: number; onAdded: () => void }) {
  const { notify } = useApp();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<AssetType>('stock');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !open) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.prices
        .search(q)
        .then((list) => mine === seq.current && setResults(list.filter((r) => !r.currency || (ASSET_CURRENCIES as readonly string[]).includes(r.currency))))
        .catch(() => mine === seq.current && setResults([]))
        .finally(() => mine === seq.current && setSearching(false));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  const add = async (r: { symbol: string; type: AssetType; name?: string; currency?: string | null }): Promise<void> => {
    setAdding(true);
    setOpen(false);
    try {
      let currency = r.currency ?? null;
      let name = r.name ?? '';
      if (!currency || !(ASSET_CURRENCIES as readonly string[]).includes(currency)) {
        // Moneda nu se știe din căutare: o aflăm de la furnizorul de prețuri.
        const q = await api.prices.lookup(r.symbol, r.type).catch(() => null);
        currency = q?.currency && (ASSET_CURRENCIES as readonly string[]).includes(q.currency) ? q.currency : r.symbol.endsWith('.RO') ? 'RON' : 'USD';
        name ||= q?.name ?? '';
      }
      await api.watchlists.addItem(watchlistId, { symbol: r.symbol, type: r.type, currency, name });
      notify('success', `${r.symbol.toUpperCase()} a fost adăugat în listă.`);
      setQuery('');
      onAdded();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const exact = results.find((r) => r.symbol.toUpperCase() === query.trim().toUpperCase());
        if (exact) void add({ symbol: exact.symbol, type: exact.type ?? type, name: exact.name, currency: exact.currency });
        else if (query.trim()) void add({ symbol: query.trim().toUpperCase(), type });
      }}
    >
      <div className="relative min-w-64 flex-1">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-3" aria-hidden />
        <Input
          className="pl-9"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder="Adaugă în listă: caută după nume sau simbol (ex.: Nvidia, VWCE.DE, BTC-USD)"
          aria-label="Caută simbolul de adăugat în listă"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="watch-results"
        />
        {open && (searching || results.length > 0) && (
          <ul id="watch-results" role="listbox" className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl">
            {searching && results.length === 0 && (
              <li className="flex items-center gap-2 px-3 py-2 text-body text-ink-3">
                <Spinner className="size-4" /> Se caută…
              </li>
            )}
            {results.map((r) => (
              <li key={`${r.symbol}-${r.exchange}`} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void add({ symbol: r.symbol, type: r.type ?? type, name: r.name, currency: r.currency })}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
                >
                  <TickerLogo symbol={r.symbol} type={r.type ?? type} size={22} />
                  <span className="w-24 shrink-0 text-body font-semibold text-ink">{r.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-body text-ink-2">{r.name}</span>
                  {r.exchange && <span className="shrink-0 text-xs text-ink-3">{r.exchange}</span>}
                  {r.type && <Badge>{ASSET_TYPE_LABEL[r.type]}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Select className="w-36!" value={type} onChange={(e) => setType(e.target.value as AssetType)} aria-label="Tipul instrumentului">
        {ASSET_TYPES.map((t) => (
          <option key={t} value={t}>
            {ASSET_TYPE_LABEL[t]}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={adding} disabled={!query.trim()}>
        Adaugă
      </Button>
    </form>
  );
}

/* ---------------------------------------------------- editarea unui element */

function EditItem({
  item,
  lists,
  onClose,
  onSave
}: {
  item: WatchlistItemView;
  lists: Watchlist[];
  onClose: () => void;
  onSave: (patch: { targetPrice: number | null; note: string; watchlistId: number }) => Promise<void>;
}) {
  const [target, setTarget] = useState(item.targetPrice === null ? '' : String(item.targetPrice).replace('.', ','));
  const [note, setNote] = useState(item.note ?? '');
  const [listId, setListId] = useState(item.watchlistId);
  const [saving, setSaving] = useState(false);
  const parsed = target.trim() ? parseNumberLoose(target) : null;
  const invalid = target.trim() !== '' && (parsed === null || parsed <= 0);

  return (
    <Modal
      title={`${item.symbol}${item.name ? ` · ${item.name}` : ''}`}
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="watch-edit" loading={saving} disabled={invalid}>
            Salvează
          </Button>
        </>
      }
    >
      <form
        id="watch-edit"
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          setSaving(true);
          void onSave({ targetPrice: parsed, note, watchlistId: listId }).finally(() => setSaving(false));
        }}
      >
        <Field
          label={`Preț țintă de cumpărare (${item.currency})`}
          hint={item.price !== null ? `Preț curent: ${fmtPrice(item.price)} ${item.currency}. Lasă gol dacă nu ai o țintă.` : 'Lasă gol dacă nu ai o țintă.'}
          error={invalid ? 'Scrie un preț mai mare decât zero.' : null}
        >
          <Input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="ex.: 120,50" className="max-w-40" autoFocus />
        </Field>
        <Field label="Notă personală">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="ex.: aștept rezultatele trimestriale" />
        </Field>
        {lists.length > 1 && (
          <Field label="Lista">
            <Select value={listId} onChange={(e) => setListId(Number(e.target.value))}>
              {lists.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Modal>
  );
}
