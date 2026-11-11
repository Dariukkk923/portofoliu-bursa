/**
 * Jurnalul de investiții: cronologia deciziilor (cele mai noi întâi), cu căutare și filtre după
 * simbol, etichetă și perioadă; tezele de revizuit; la vânzări, planul inițial lângă rezultatul
 * real; export PDF și CSV.
 */
import { useMemo, useState } from 'react';
import { CircleCheck, FileDown, FileText, NotebookPen, Pencil, Plus, Search, Trash2, TriangleAlert, Info } from 'lucide-react';
import type { JournalEntry, JournalFilters } from '@shared/types';
import { JOURNAL_REVIEW_MONTHS } from '@shared/types';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, signedMoney, signedPercent } from '../lib/format';
import { TickerLogo } from '../components/TickerLogo';
import { JournalEntryForm, PlanChips, horizonLabel } from '../components/journal';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, ListSkeleton, LoadError, Select, cx } from '../components/ui';

const KIND_LABEL = { buy: 'Cumpărare', sell: 'Vânzare', note: 'Notă' } as const;
const KIND_TONE = { buy: 'gain', sell: 'loss', note: 'neutral' } as const;
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const monthTitle = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

function Outcome({ e }: { e: JournalEntry }) {
  const o = e.outcome;
  if (!o) return null;
  return (
    <div className={cx('mt-2 rounded-lg border p-3', o.respected ? 'border-gain/30 bg-gain/5' : 'border-warn/40 bg-warn/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-body font-semibold text-ink">Planul tău vs. rezultatul real</p>
        <Badge tone={o.respected ? 'gain' : 'warn'}>{o.respected ? 'Plan respectat' : 'Abatere de la plan'}</Badge>
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-ink-3">Planul din {fmtDate(o.plan.date)}</p>
          {o.plan.reason && <p className="mt-0.5 text-body text-ink-2 italic">„{o.plan.reason}”</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <PlanChips e={{ ...o.plan, currency: e.currency }} />
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-ink-3">Vânzarea din {fmtDate(o.saleDate)}</p>
          <p className="tabular mt-0.5 text-body text-ink">
            {o.quantity.toLocaleString('ro-RO', { maximumFractionDigits: 8 })} × {money(o.salePrice, e.currency)}
            {o.gain !== null && (
              <>
                {' · '}
                <span className={cx('font-semibold', o.gain >= 0 ? 'text-gain' : 'text-loss')}>
                  {signedMoney(o.gain, e.currency)}
                  {o.gainPct !== null && ` (${signedPercent(o.gainPct, 1)})`}
                </span>
              </>
            )}
          </p>
          <p className="text-xs text-ink-3">după {o.heldDays} {o.heldDays === 1 ? 'zi' : 'zile'} de la decizie</p>
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {o.checks.map((c) => (
          <li key={c.text} className="flex items-start gap-1.5 text-xs">
            {c.tone === 'ok' ? (
              <CircleCheck className="mt-px size-3.5 shrink-0 text-gain" aria-hidden />
            ) : c.tone === 'warn' ? (
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
            ) : (
              <Info className="mt-px size-3.5 shrink-0 text-ink-3" aria-hidden />
            )}
            <span className="text-ink-2">{c.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntryItem({ e, onEdit, onDelete, onTag }: { e: JournalEntry; onEdit: () => void; onDelete: () => void; onTag: (t: string) => void }) {
  return (
    <li className="flex gap-3 py-3.5">
      <TickerLogo symbol={e.symbol} type={e.assetType} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold text-ink">{e.symbol}</span>
          <Badge tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind]}</Badge>
          <span className="text-xs text-ink-3">
            {fmtDate(e.date)} · {e.portfolioName}
            {e.trade && ` · ${e.trade.quantity.toLocaleString('ro-RO', { maximumFractionDigits: 8 })} × ${money(e.trade.price, e.currency)}`}
          </span>
          {e.id !== null && (
            <span className="ml-auto flex">
              <IconButton label={`Editează nota despre ${e.symbol}`} onClick={onEdit}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton label={`Șterge nota despre ${e.symbol}`} onClick={onDelete}>
                <Trash2 className="size-4" />
              </IconButton>
            </span>
          )}
        </div>
        {e.reason ? (
          <p className="mt-1 text-body whitespace-pre-line text-ink">{e.reason}</p>
        ) : (
          e.id === null && <p className="mt-1 text-xs text-ink-3">Vânzare fără notă în jurnal; se compară cu planul de la cumpărare.</p>
        )}
        {(e.targetPrice !== null || e.stopLoss !== null || e.horizonMonths !== null || e.confidence !== null || e.tags.length > 0 || e.reviewDate) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <PlanChips e={e} />
            {e.tags.map((t) => (
              <button key={t} type="button" onClick={() => onTag(t)} className="rounded-md px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft">
                #{t}
              </button>
            ))}
            {e.reviewDate && (
              <span className="text-xs text-ink-3">{e.reviewedAt ? `revizuit (${fmtDate(e.reviewedAt.slice(0, 10))})` : `revizuire: ${fmtDate(e.reviewDate)}`}</span>
            )}
          </div>
        )}
        <Outcome e={e} />
      </div>
    </li>
  );
}

export function JournalPage() {
  const { filter, dataVersion, bumpData, notify } = useApp();
  const [search, setSearch] = useState('');
  const [symbol, setSymbol] = useState('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [form, setForm] = useState<{ entry: JournalEntry | null } | null>(null);
  const [deleting, setDeleting] = useState<JournalEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const filters: JournalFilters = { portfolioId: filter.portfolioId ?? null, symbol: symbol || null, tag: tag || null, from: from || null, to: to || null, search: search || null };
  const list = useLoad(() => api.journal.list(filters), [JSON.stringify(filters), dataVersion]);
  const assets = useLoad(() => api.assets.list(), [dataVersion]);
  const data = list.data;
  const filtered = !!(search || symbol || tag || from || to);

  const groups = useMemo(() => {
    const out: { title: string; items: JournalEntry[] }[] = [];
    for (const e of data?.entries ?? []) {
      const title = monthTitle(e.date);
      if (out[out.length - 1]?.title !== title) out.push({ title, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [data]);

  const run = async (key: string, task: () => Promise<unknown>, success?: string): Promise<void> => {
    setBusy(key);
    try {
      await task();
      if (success) notify('success', success);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const exportFile = async (kind: 'pdf' | 'csv'): Promise<void> => {
    setBusy(kind);
    try {
      const res = kind === 'pdf' ? await api.journal.exportPdf(filters) : await api.journal.exportCsv(filters);
      if (!res.canceled) notify('success', `Jurnalul (${res.count} intrări) a fost salvat în ${res.path}.`);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-body text-ink-2">
          De ce ai cumpărat sau vândut, ce plan aveai și cât de sigur erai. La vânzare vezi planul inițial lângă rezultatul real.
        </p>
        <Button icon={<FileDown className="size-4" />} loading={busy === 'csv'} disabled={!data || data.entries.length === 0} onClick={() => void exportFile('csv')}>
          Export CSV
        </Button>
        <Button icon={<FileText className="size-4" />} loading={busy === 'pdf'} disabled={!data || data.entries.length === 0} onClick={() => void exportFile('pdf')}>
          Export PDF
        </Button>
        <Button variant="primary" icon={<Plus className="size-4" />} disabled={!assets.data || assets.data.length === 0} onClick={() => setForm({ entry: null })}>
          Notează în jurnal
        </Button>
      </div>

      {data && data.dueReviews.length > 0 && (
        <Card title={`De revizuit (${data.dueReviews.length})`}>
          <p className="mb-2 text-xs text-ink-2">Ți-ai propus să verifici dacă teza mai e valabilă. Mai crezi în motivul pentru care ai investit?</p>
          <ul className="divide-y divide-line">
            {data.dueReviews.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center gap-3 py-2.5">
                <TickerLogo symbol={e.symbol} type={e.assetType} size={26} />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">
                    {e.symbol} <span className="font-normal text-ink-3">· notă din {fmtDate(e.date)}, revizuire pe {fmtDate(e.reviewDate)}</span>
                  </p>
                  {e.reason && <p className="truncate text-xs text-ink-2">{e.reason}</p>}
                </div>
                <Button size="sm" onClick={() => setForm({ entry: e })}>
                  Actualizează teza
                </Button>
                <Select
                  className="w-44!"
                  aria-label={`Revizuiește din nou ${e.symbol}`}
                  value=""
                  onChange={(ev) => void run(`r${e.id}`, () => api.journal.markReviewed(e.id as number, ev.target.value ? Number(ev.target.value) : null), 'Teza a fost marcată ca revizuită.')}
                >
                  <option value="" disabled>
                    Marchează revizuit…
                  </option>
                  <option value="">Revizuit, fără alt memento</option>
                  {JOURNAL_REVIEW_MONTHS.map((m) => (
                    <option key={m} value={m}>
                      Revizuit, din nou peste {horizonLabel(m)}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input className="pl-8!" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Caută în motive, simboluri, etichete…" aria-label="Caută în jurnal" />
          </div>
          <Select className="w-44! max-md:w-full!" value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Filtru simbol">
            <option value="">Toate simbolurile</option>
            {(data?.symbols ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select className="w-44! max-md:w-full!" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filtru etichetă">
            <option value="">Toate etichetele</option>
            {(data?.tags ?? []).map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-ink-2 max-md:w-full">
            de la
            <Input type="date" className="w-36! max-md:w-auto! max-md:flex-1" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="De la data" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-2 max-md:w-full">
            până la
            <Input type="date" className="w-36! max-md:w-auto! max-md:flex-1" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Până la data" />
          </label>
          {filtered && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setSymbol('');
                setTag('');
                setFrom('');
                setTo('');
              }}
            >
              Șterge filtrele
            </Button>
          )}
        </div>

        {list.error ? (
          <LoadError message={list.error} onRetry={list.reload} />
        ) : !data ? (
          <ListSkeleton />
        ) : data.entries.length === 0 ? (
          <EmptyState
            icon={<NotebookPen className="size-5" />}
            title={filtered ? 'Nicio intrare pentru filtrele alese' : 'Jurnalul este gol'}
            text={filtered ? 'Schimbă sau șterge filtrele.' : 'Notează motivul și planul la următoarea cumpărare (în formular) sau oricând, pe o poziție.'}
            action={
              !filtered &&
              !!assets.data?.length && (
                <Button icon={<Plus className="size-4" />} onClick={() => setForm({ entry: null })}>
                  Scrie prima notă
                </Button>
              )
            }
          />
        ) : (
          <div className="px-4 pb-2">
            {groups.map((g) => (
              <section key={g.title}>
                <h3 className="sticky top-0 z-[1] -mx-4 border-b border-line bg-surface px-4 pt-3 pb-1.5 text-xs font-semibold tracking-wide text-ink-3 uppercase">{g.title}</h3>
                <ul className="divide-y divide-line">
                  {g.items.map((e) => (
                    <EntryItem key={e.key} e={e} onEdit={() => setForm({ entry: e })} onDelete={() => setDeleting(e)} onTag={setTag} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {form && assets.data && (
        <JournalEntryForm
          entry={form.entry}
          assets={assets.data}
          tagSuggestions={data?.tags}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            bumpData();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Ștergi nota din jurnal?"
          message={`Nota despre ${deleting.symbol} din ${fmtDate(deleting.date)} se șterge definitiv. Tranzacția rămâne.`}
          busy={busy === 'delete'}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            void run('delete', () => api.journal.remove(deleting.id as number), 'Nota a fost ștearsă.').then(() => setDeleting(null))
          }
        />
      )}
    </>
  );
}
