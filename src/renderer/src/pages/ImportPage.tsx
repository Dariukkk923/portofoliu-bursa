/**
 * Ecranul „Import”: extrasul exportat de la broker (CSV sau Excel) devine
 * tranzacții, după o previzualizare.
 *
 *  1. Utilizatorul alege fișierul. Formatul se recunoaște după structură (XTB,
 *     Trading 212, Revolut, Interactive Brokers); pentru orice alt tabel se
 *     propune maparea coloanelor, care se poate salva ca șablon.
 *  2. Previzualizarea arată fiecare rând: nou, deja în aplicație (dublură),
 *     eroare sau ignorat, plus instrumentele pe care aplicația nu le-a putut
 *     identifica (utilizatorul scrie simbolul corect; răspunsul se ține minte).
 *  3. Importul se salvează ca lot; din lista importurilor, un lot se poate anula complet.
 *
 * Fișierul este citit doar pe acest calculator; aplicația nu se conectează la contul de la broker.
 */
import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, FileSpreadsheet, FileUp, History, RotateCcw, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import {
  ASSET_CURRENCIES,
  type CsvImportResult,
  type ImportOptions,
  type ImportPreview,
  type ImportResult,
  type ImportRowStatus,
  type ImportSessionView
} from '@shared/types';
import { MAPPED_FIELDS, STATEMENT_KIND_LABEL, STATEMENT_KINDS, SUPPORTED_BROKERS, type ColumnMapping, type MappedField, type StatementKind } from '@shared/import';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, dateTime, money, price as fmtPrice, quantity as fmtQuantity } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, Field, IconButton, Input, ListSkeleton, Notice, Segmented, Select, Spinner, TD, TH, cx } from '../components/ui';

/** „1 tranzacție”, „5 tranzacții”, „25 de tranzacții”. */
export function count(n: number, one: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const lastTwo = n % 100;
  return `${n} ${n >= 20 && (lastTwo === 0 || lastTwo >= 20) ? 'de ' : ''}${many}`;
}

const STATUS: Record<ImportRowStatus, { label: string; tone: 'gain' | 'neutral' | 'loss' | 'warn' | 'accent' }> = {
  new: { label: 'Nou', tone: 'gain' },
  warning: { label: 'De verificat', tone: 'warn' },
  duplicate: { label: 'Deja în aplicație', tone: 'neutral' },
  error: { label: 'Eroare', tone: 'loss' },
  skipped: { label: 'Ignorat', tone: 'neutral' }
};

type RowFilter = 'all' | 'new' | 'duplicate' | 'error';
const MAX_ROWS_SHOWN = 400;
const differs = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function kindSummary(byKind: Partial<Record<StatementKind, number>>): string {
  return STATEMENT_KINDS.filter((k) => byKind[k])
    .map((k) => `${STATEMENT_KIND_LABEL[k].toLowerCase()}: ${byKind[k]}`)
    .join(', ');
}

export function ImportPage() {
  const { notify, bumpData, reloadBrokers, reloadPortfolios, brokers, activePortfolios, defaultPortfolioId, importRequest, takeImportRequest, dataVersion } = useApp();
  const [session, setSession] = useState<ImportSessionView | null>(null);
  const [options, setOptions] = useState<ImportOptions>({});
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [rememberTemplate, setRememberTemplate] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'open' | 'preview' | 'apply' | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [csv, setCsv] = useState<CsvImportResult | null>(null);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [undoing, setUndoing] = useState<number | null>(null);
  const batches = useLoad(() => api.imports.batches(), [dataVersion, result]);
  const templates = useLoad(() => api.imports.templates(), [dataVersion, result]);

  const reset = (): void => {
    if (session) void api.imports.discard(session.token).catch(() => undefined);
    setSession(null);
    setMapping(null);
    setAnswers({});
    setOptions({});
    setFilter('all');
  };

  const start = async (): Promise<void> => {
    setBusy('open');
    setResult(null);
    setCsv(null);
    try {
      const first: ImportOptions = { portfolioId: defaultPortfolioId };
      const res = await api.imports.open(first);
      if (res.canceled) return;
      if (res.csv) {
        reset();
        setCsv(res.csv);
        if (res.csv.imported > 0) {
          await Promise.all([reloadBrokers(), reloadPortfolios()]);
          bumpData();
        }
        return;
      }
      if (!res.session) return;
      setSession(res.session);
      setOptions(first);
      setAnswers({});
      setMapping(res.session.mapping?.mapping ?? null);
      setTemplateName(res.session.mapping?.templateName ?? `Șablon ${res.session.fileName.replace(/\.[^.]+$/, '')}`.slice(0, 60));
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Butonul „Import Excel / CSV” din alte pagini deschide direct alegerea fișierului.
  useEffect(() => {
    if (takeImportRequest(importRequest)) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRequest]);

  const refresh = async (next: ImportOptions): Promise<void> => {
    if (!session) return;
    setOptions(next);
    setBusy('preview');
    try {
      const view = await api.imports.preview(session.token, next);
      setSession(view);
      if (view.mapping) setMapping(view.mapping.mapping);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (): Promise<void> => {
    if (!session) return;
    setBusy('apply');
    try {
      const done = await api.imports.apply(session.token, {
        ...options,
        mapping: session.mapping ? mapping : null,
        templateName: session.mapping && rememberTemplate ? templateName : null
      });
      setResult(done);
      setSession(null);
      await Promise.all([reloadBrokers(), reloadPortfolios()]);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const undo = async (id: number): Promise<void> => {
    try {
      const res = await api.imports.undo(id);
      notify('success', `Importul a fost anulat: ${count(res.removed, 'tranzacție ștearsă', 'tranzacții șterse')}${res.restored > 0 ? `, ${count(res.restored, 'tranzacție manuală pusă la loc', 'tranzacții manuale puse la loc')}` : ''}.`);
      await Promise.all([reloadBrokers(), reloadPortfolios()]);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setUndoing(null);
    }
  };

  const preview = session?.preview ?? null;

  return (
    <>
      {!session && (
        <Card>
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <FileUp className="size-5" aria-hidden />
            </div>
            <div className="min-w-60 flex-1">
              <h2 className="text-base font-semibold text-ink">Importă extrasul de la broker</h2>
              <p className="mt-1 text-body text-ink-2">
                Exportă istoricul contului din aplicația brokerului (CSV sau Excel) și alege fișierul. Recunosc singur {SUPPORTED_BROKERS.join(', ')}; pentru orice alt fișier
                îmi spui o singură dată ce conține fiecare coloană. Înainte de salvare vezi exact ce se adaugă, iar operațiunile importate deja nu se dublează.
              </p>
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-3">
                <ShieldCheck className="size-3.5" aria-hidden /> Fișierul este citit doar pe acest calculator. Aplicația nu se conectează la contul tău de la broker.
              </p>
            </div>
            <Button variant="primary" icon={<FileSpreadsheet className="size-4" />} loading={busy === 'open'} onClick={() => void start()}>
              Alege fișierul
            </Button>
          </div>
        </Card>
      )}

      {csv && <CsvResult result={csv} onClose={() => setCsv(null)} />}
      {result && <ResultCard result={result} onClose={() => setResult(null)} />}

      {session?.mapping && mapping && (
        <MappingCard
          session={session}
          mapping={mapping}
          onChange={setMapping}
          templateName={templateName}
          onTemplateName={setTemplateName}
          remember={rememberTemplate}
          onRemember={setRememberTemplate}
          busy={busy === 'preview'}
          collapsed={!!preview}
          onApply={() => void refresh({ ...options, mapping })}
          onCancel={reset}
        />
      )}

      {preview && session && (
        <PreviewCard
          preview={preview}
          options={options}
          answers={answers}
          onAnswers={setAnswers}
          brokers={brokers}
          portfolios={activePortfolios}
          filter={filter}
          onFilter={setFilter}
          busy={busy}
          onOptions={(next) => void refresh({ ...next, mapping: session.mapping ? mapping : null })}
          onApply={() => void apply()}
          onCancel={reset}
        />
      )}

      <Card title="Importuri anterioare" padded={false} action={<History className="size-4 text-ink-3" aria-hidden />}>
        {!batches.data ? (
          <ListSkeleton rows={3} />
        ) : batches.data.length === 0 ? (
          <p className="px-4 pb-4 text-body text-ink-3">Niciun import încă. Fiecare import apare aici și poate fi anulat complet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH}>Importat la</th>
                  <th className={TH}>Fișier</th>
                  <th className={TH}>Broker · portofoliu</th>
                  <th className={TH}>Perioada</th>
                  <th className={cx(TH, 'text-right')}>Tranzacții</th>
                  <th className={TH} aria-label="Acțiuni" />
                </tr>
              </thead>
              <tbody>
                {batches.data.map((b) => (
                  <tr key={b.id} className="border-b border-line last:border-0">
                    <td className={cx(TD, 'tabular')}>{dateTime(b.createdAt.replace(' ', 'T') + 'Z')}</td>
                    <td className={cx(TD, 'max-w-64')}>
                      <div className="truncate font-medium" title={b.fileName ?? undefined}>
                        {b.fileName ?? '—'}
                      </div>
                      <div className="text-xs text-ink-3">{b.formatLabel}</div>
                    </td>
                    <td className={TD}>
                      {b.brokerName ?? '—'}
                      {b.portfolioName && <span className="text-ink-3"> · {b.portfolioName}</span>}
                    </td>
                    <td className={cx(TD, 'tabular text-ink-2')}>{b.dateFrom ? `${fmtDate(b.dateFrom)} – ${fmtDate(b.dateTo)}` : '—'}</td>
                    <td className={cx(TD, 'tabular text-right')} title={kindSummary(b.summary)}>
                      {b.remaining === b.txCount ? b.txCount : `${b.remaining} din ${b.txCount}`}
                    </td>
                    <td className={cx(TD, 'text-right')}>
                      <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setUndoing(b.id)}>
                        Anulează
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(templates.data ?? []).length > 0 && (
        <Card title="Șabloane de mapare salvate">
          <ul className="divide-y divide-line">
            {(templates.data ?? []).map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2 text-body">
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.name}</span>
                <span className="text-xs text-ink-3">{t.lastUsedAt ? `folosit ultima dată ${fmtDate(t.lastUsedAt.slice(0, 10))}` : ''}</span>
                <IconButton
                  label={`Șterge șablonul „${t.name}”`}
                  onClick={() =>
                    void api.imports
                      .deleteTemplate(t.id)
                      .then(templates.reload)
                      .catch((err) => notify('error', errorMessage(err)))
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-3">Un șablon se aplică automat fișierelor cu exact aceleași coloane.</p>
        </Card>
      )}

      {undoing !== null && (
        <ConfirmDialog
          title="Anulezi importul?"
          confirmLabel="Anulează importul"
          message={
            <>
              Se șterg toate tranzacțiile din acest import, activele create de el (dacă nu mai sunt folosite) și se pun la loc tranzacțiile manuale pe care le-a înlocuit.
              Poziții, cost și cash se recalculează automat.
            </>
          }
          onCancel={() => setUndoing(null)}
          onConfirm={() => void undo(undoing)}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- maparea */

function MappingCard({
  session,
  mapping,
  onChange,
  templateName,
  onTemplateName,
  remember,
  onRemember,
  busy,
  collapsed,
  onApply,
  onCancel
}: {
  session: ImportSessionView;
  mapping: ColumnMapping;
  onChange: (m: ColumnMapping) => void;
  templateName: string;
  onTemplateName: (s: string) => void;
  remember: boolean;
  onRemember: (b: boolean) => void;
  busy: boolean;
  collapsed: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const info = session.mapping;
  const [open, setOpen] = useState(!collapsed);
  useEffect(() => setOpen(!collapsed), [collapsed]);
  if (!info) return null;
  const setColumn = (field: MappedField, key: string): void => {
    const columns = { ...mapping.columns };
    if (key) columns[field] = key;
    else delete columns[field];
    onChange({ ...mapping, columns });
  };
  const setType = (key: string, kind: string): void => onChange({ ...mapping, types: { ...mapping.types, [key]: kind as StatementKind | 'ignore' } });
  const sampleOf = (key: string): string => {
    const i = info.keys.indexOf(key);
    return info.sample.map((r) => r[i]).find((v) => v && v.trim()) ?? '';
  };

  if (!open) {
    return (
      <Notice tone="accent" action={<Button size="sm" onClick={() => setOpen(true)}>Schimbă maparea</Button>}>
        Fișier citit cu {info.templateName ? `șablonul „${info.templateName}”` : 'maparea aleasă'} ({session.fileName}).
      </Notice>
    );
  }

  return (
    <Card title={`Ce conține fiecare coloană? · ${session.fileName}`}>
      <p className="-mt-1 mb-3 text-body text-ink-2">
        Nu recunosc formatul acestui fișier. Am propus coloanele după denumiri; verifică-le și corectează ce lipsește. O dată salvată, maparea se aplică automat fișierelor cu aceleași coloane.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {MAPPED_FIELDS.map(({ field, label, hint }) => (
          <Field key={field} label={label} hint={mapping.columns[field] ? `ex.: ${sampleOf(mapping.columns[field] as string) || '—'}` : hint}>
            <Select value={mapping.columns[field] ?? ''} onChange={(e) => setColumn(field, e.target.value)}>
              <option value="">— nu există —</option>
              {info.headers.map((h, i) =>
                info.keys[i] ? (
                  <option key={info.keys[i]} value={info.keys[i]}>
                    {h}
                  </option>
                ) : null
              )}
            </Select>
          </Field>
        ))}
        <Field label="Formatul datei">
          <Select value={mapping.dateOrder} onChange={(e) => onChange({ ...mapping, dateOrder: e.target.value as ColumnMapping['dateOrder'] })}>
            <option value="dmy">ZZ.LL.AAAA (ziua întâi)</option>
            <option value="mdy">LL/ZZ/AAAA (luna întâi)</option>
            <option value="ymd">AAAA-LL-ZZ</option>
          </Select>
        </Field>
        <Field label="Separatorul zecimal">
          <Select value={mapping.decimalComma ? 'comma' : 'dot'} onChange={(e) => onChange({ ...mapping, decimalComma: e.target.value === 'comma' })}>
            <option value="comma">Virgulă (1.234,56)</option>
            <option value="dot">Punct (1,234.56)</option>
          </Select>
        </Field>
        <Field label="Moneda, dacă lipsește din fișier">
          <Select value={mapping.defaultCurrency ?? ''} onChange={(e) => onChange({ ...mapping, defaultCurrency: e.target.value || null })}>
            <option value="">—</option>
            {ASSET_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {info.typeValues.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-body font-medium text-ink-2">Ce înseamnă valorile din coloana de tip</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {info.typeValues.map((t) => {
              const current = mapping.types[t.key] ?? t.kind ?? '';
              return (
                <label key={t.key} className={cx('flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-body', current ? 'border-line' : 'border-loss bg-loss-soft')}>
                  <span className="min-w-0 flex-1 truncate text-ink" title={t.value}>
                    „{t.value}” <span className="text-xs text-ink-3">× {t.count}</span>
                  </span>
                  <Select className="w-40!" value={current} onChange={(e) => setType(t.key, e.target.value)} aria-label={`Tipul pentru „${t.value}”`}>
                    <option value="">— alege —</option>
                    {STATEMENT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {STATEMENT_KIND_LABEL[k]}
                      </option>
                    ))}
                    <option value="ignore">Nu importa</option>
                  </Select>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              {info.headers.map((h, i) => (
                <th key={i} className={cx(TH, 'text-ink-2')}>
                  {h || `(coloana ${i + 1})`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {info.sample.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {r.map((c, j) => (
                  <td key={j} className={cx(TD, 'max-w-48 truncate text-ink-2')}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-body text-ink">
          <input type="checkbox" className="size-4 accent-accent" checked={remember} onChange={(e) => onRemember(e.target.checked)} />
          Ține minte maparea ca
        </label>
        <Input className="w-72!" value={templateName} onChange={(e) => onTemplateName(e.target.value)} disabled={!remember} aria-label="Numele șablonului" maxLength={60} />
        <div className="ml-auto flex gap-2">
          <Button onClick={onCancel}>Renunță</Button>
          <Button variant="primary" loading={busy} disabled={!mapping.columns.date} onClick={onApply}>
            {collapsed ? 'Aplică maparea' : 'Continuă'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------- previzualizarea */

function PreviewCard({
  preview,
  options,
  answers,
  onAnswers,
  brokers,
  portfolios,
  filter,
  onFilter,
  busy,
  onOptions,
  onApply,
  onCancel
}: {
  preview: ImportPreview;
  options: ImportOptions;
  answers: Record<string, string>;
  onAnswers: (a: Record<string, string>) => void;
  brokers: { id: number; name: string }[];
  portfolios: { id: number; name: string }[];
  filter: RowFilter;
  onFilter: (f: RowFilter) => void;
  busy: 'open' | 'preview' | 'apply' | null;
  onOptions: (o: ImportOptions) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [newBroker, setNewBroker] = useState(preview.brokerId === null ? preview.brokerName : '');
  const toImport = preview.counts.new + preview.counts.warning;
  const unconfirmed = preview.instruments.filter((i) => i.status === 'unconfirmed');
  const [showAll, setShowAll] = useState(false);
  const instruments = showAll ? preview.instruments : unconfirmed;
  const rows = useMemo(
    () =>
      preview.rows.filter((r) =>
        filter === 'all' ? true : filter === 'new' ? r.status === 'new' || r.status === 'warning' : filter === 'duplicate' ? r.status === 'duplicate' : r.status === 'error'
      ),
    [preview.rows, filter]
  );
  const answered = Object.keys(answers).length > 0;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <CircleCheck className="size-4 text-gain" aria-hidden />
          {preview.formatLabel}
          <span className="font-normal text-ink-3">
            · {preview.fileName}
            {preview.dateFrom && ` · ${fmtDate(preview.dateFrom)} – ${fmtDate(preview.dateTo)}`}
          </span>
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {portfolios.length > 1 && (
          <Field label="În portofoliul">
            <Select value={options.portfolioId ?? preview.portfolioId} onChange={(e) => onOptions({ ...options, portfolioId: Number(e.target.value) })}>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="La brokerul">
          <Select
            value={preview.brokerId ?? ''}
            onChange={(e) => onOptions({ ...options, brokerId: e.target.value ? Number(e.target.value) : null, brokerName: e.target.value ? null : newBroker || preview.brokerName })}
          >
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="">+ Broker nou…</option>
          </Select>
        </Field>
        {preview.brokerId === null && (
          <Field label="Numele brokerului nou">
            <Input
              value={newBroker}
              onChange={(e) => setNewBroker(e.target.value)}
              onBlur={() => newBroker.trim() && newBroker.trim() !== preview.brokerName && onOptions({ ...options, brokerId: null, brokerName: newBroker.trim() })}
              maxLength={60}
            />
          </Field>
        )}
        {preview.accountCurrency && (
          <Field label="Moneda contului">
            <Input value={preview.accountCurrency} readOnly className="text-ink-2" />
          </Field>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-body">
        <Badge tone="gain">{count(toImport, 'tranzacție nouă', 'tranzacții noi')}</Badge>
        {preview.counts.duplicate > 0 && <Badge>{count(preview.counts.duplicate, 'deja în aplicație', 'deja în aplicație')}</Badge>}
        {preview.counts.error > 0 && <Badge tone="loss">{count(preview.counts.error, 'eroare', 'erori')}</Badge>}
        {preview.counts.skipped > 0 && <Badge>{count(preview.counts.skipped, 'ignorată', 'ignorate')}</Badge>}
        {toImport > 0 && <span className="text-xs text-ink-3">({kindSummary(preview.byKind)})</span>}
      </div>

      {preview.manualCount > 0 && (
        <label className="mt-4 flex items-start gap-2.5 rounded-lg border border-warn bg-warn-soft px-3 py-2.5 text-body text-ink">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-accent"
            checked={!!options.replaceManual}
            onChange={(e) => onOptions({ ...options, replaceManual: e.target.checked })}
          />
          <span>
            <strong>Ai deja {count(preview.manualCount, 'tranzacție introdusă', 'tranzacții introduse')} manual</strong> la {preview.brokerName} pentru instrumentele din fișier. Cele
            identice sunt recunoscute ca dubluri; bifează ca să le înlocuiesc pe toate cu cele din extras (anularea importului le pune la loc).
          </span>
        </label>
      )}

      {(unconfirmed.length > 0 || showAll) && (
        <div className="mt-4 rounded-lg border border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <p className="text-body font-medium text-ink">
              {unconfirmed.length > 0 ? `Nu am putut identifica ${count(unconfirmed.length, 'instrument', 'instrumente')}` : 'Instrumentele din fișier'}
            </p>
            <span className="text-xs text-ink-3">Scrie simbolul folosit de aplicație (ex.: VWCE.DE, AAPL, SNP.RO) sau lasă-l gol ca să nu-l imporți. Răspunsul se ține minte.</span>
          </div>
          <ul className="divide-y divide-line">
            {instruments.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-3 px-3 py-2 text-body">
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-ink">{i.brokerSymbol ?? i.isin}</span>
                  {i.isin && i.brokerSymbol && <span className="ml-1.5 text-xs text-ink-3">{i.isin}</span>}
                  {i.name && <div className="truncate text-xs text-ink-3">{i.name}</div>}
                </div>
                <Badge tone={i.status === 'unconfirmed' ? 'warn' : i.status === 'incomplete' ? 'loss' : i.status === 'skipped' ? 'neutral' : 'gain'}>
                  {{ existing: 'în portofoliu', confirmed: 'găsit', unconfirmed: 'negăsit', skipped: 'ignorat', incomplete: 'istoric incomplet' }[i.status]}
                </Badge>
                <Input
                  className="w-36! uppercase"
                  aria-label={`Simbolul pentru ${i.brokerSymbol ?? i.isin}`}
                  value={answers[i.key] ?? (i.status === 'skipped' ? '' : i.symbol)}
                  onChange={(e) => onAnswers({ ...answers, [i.key]: e.target.value.toUpperCase() })}
                />
                <span className="w-10 text-xs text-ink-3">{i.currency}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 px-3 py-2">
            <Button size="sm" loading={busy === 'preview'} disabled={!answered} onClick={() => onOptions({ ...options, symbols: { ...options.symbols, ...answers } })}>
              Verifică simbolurile
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Doar cele neidentificate' : `Toate instrumentele (${preview.instruments.length})`}
            </Button>
          </div>
        </div>
      )}
      {unconfirmed.length === 0 && !showAll && preview.instruments.length > 0 && (
        <button type="button" className="mt-3 text-body font-medium text-accent hover:underline" onClick={() => setShowAll(true)}>
          Vezi cele {preview.instruments.length} instrumente și simbolurile lor
        </button>
      )}

      {preview.offline && <Notice tone="warn">Fără conexiune la internet: simbolurile noi nu au putut fi verificate; moneda și tipul au fost deduse din fișier.</Notice>}
      {preview.warnings.map((w) => (
        <div key={w} className="mt-3">
          <Notice tone="accent">{w}</Notice>
        </div>
      ))}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Segmented
          size="sm"
          value={filter}
          onChange={onFilter}
          options={[
            { value: 'all', label: `Toate (${preview.rows.length})` },
            { value: 'new', label: `Noi (${toImport})` },
            { value: 'duplicate', label: `Dubluri (${preview.counts.duplicate})` },
            { value: 'error', label: `Erori (${preview.counts.error})` }
          ]}
        />
        {preview.ignored.length > 0 && (
          <span className="text-xs text-ink-3">Nu se importă: {preview.ignored.map((i) => `${i.label} (${i.count})`).join(', ')}.</span>
        )}
      </div>
      <div className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-line">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line">
              <th className={TH}>Rând</th>
              <th className={TH}>Data</th>
              <th className={TH}>Tip</th>
              <th className={TH}>Instrument</th>
              <th className={cx(TH, 'text-right')}>Cantitate</th>
              <th className={cx(TH, 'text-right')}>Preț</th>
              <th className={cx(TH, 'text-right')}>Sumă</th>
              <th className={TH}>Stare</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_ROWS_SHOWN).map((r, i) => (
              <tr key={`${r.line}-${i}`} className={cx('border-b border-line last:border-0', r.status === 'error' && 'bg-loss-soft/50', r.status === 'duplicate' && 'text-ink-3')}>
                <td className={cx(TD, 'tabular text-ink-3')}>{r.line}</td>
                <td className={cx(TD, 'tabular')}>{r.date ? fmtDate(r.date) : '—'}</td>
                <td className={TD}>{r.date ? STATEMENT_KIND_LABEL[r.kind] : '—'}</td>
                <td className={TD}>
                  {r.symbol ? <span className="font-semibold">{r.symbol}</span> : r.currency ? <span className="text-ink-2">Cash {r.currency}</span> : '—'}
                  {r.brokerSymbol && r.brokerSymbol !== r.symbol && <span className="ml-1.5 text-xs text-ink-3">{r.brokerSymbol}</span>}
                </td>
                <td className={cx(TD, 'tabular text-right')}>{r.quantity !== null && (r.kind === 'buy' || r.kind === 'sell') ? fmtQuantity(r.quantity) : ''}</td>
                <td className={cx(TD, 'tabular text-right')}>{r.price !== null && (r.kind === 'buy' || r.kind === 'sell') ? fmtPrice(r.price) : ''}</td>
                <td className={cx(TD, 'tabular text-right')}>
                  {r.amount !== null && r.kind !== 'buy' && r.kind !== 'sell' && r.kind !== 'split' ? money(r.amount, r.currency ?? '') : ''}
                  {r.tax ? <div className="text-xs text-ink-3">impozit {money(r.tax, r.currency ?? '')}</div> : null}
                </td>
                <td className={cx(TD, 'whitespace-normal')}>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  {r.message && <div className="mt-0.5 max-w-80 text-xs text-ink-2">{r.message}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > MAX_ROWS_SHOWN && <p className="px-3 py-2 text-xs text-ink-3">…și încă {rows.length - MAX_ROWS_SHOWN} rânduri.</p>}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {busy === 'preview' && <Spinner className="size-4" />}
        <Button icon={<RotateCcw className="size-4" />} onClick={onCancel}>
          Renunță
        </Button>
        <Button variant="primary" loading={busy === 'apply'} disabled={toImport === 0 || busy !== null} onClick={onApply}>
          {toImport === 0 ? 'Nimic nou de importat' : `Importă ${count(toImport, 'tranzacție', 'tranzacții')}`}
        </Button>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- rezultatul */

function ResultCard({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const showReported = result.positions.some((p) => p.reportedQuantity !== null);
  const mismatched = result.positions.filter((p) => p.reportedQuantity !== null && differs(p.quantity, p.reportedQuantity));
  return (
    <Card title={result.imported > 0 ? 'Import finalizat' : 'Nimic nou de importat'} action={<Button size="sm" variant="primary" onClick={onClose}>Gata</Button>}>
      <div className="space-y-3 text-body text-ink-2">
        <p className="text-sm text-ink">
          {result.imported > 0 ? (
            <>
              Am adăugat <strong>{count(result.imported, 'tranzacție', 'tranzacții')}</strong> la {result.brokerName}
              {result.portfolioName && <>, în portofoliul „{result.portfolioName}”</>} ({kindSummary(result.byKind)}).
            </>
          ) : (
            <>Toate operațiunile din fișier erau deja în aplicație.</>
          )}
          {result.duplicates > 0 && <> {count(result.duplicates, 'operațiune era', 'operațiuni erau')} deja în aplicație.</>}
          {result.createdAssets > 0 && <> {count(result.createdAssets, 'activ nou', 'active noi')} în portofoliu.</>}
          {result.replaced > 0 && <> {count(result.replaced, 'tranzacție manuală a fost înlocuită', 'tranzacții manuale au fost înlocuite')}.</>}
          {result.templateSaved && <> Maparea a fost salvată ca „{result.templateSaved}”.</>}
        </p>
        {result.positions.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="max-h-64 overflow-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-line">
                    <th className={TH}>Deții acum la {result.brokerName}</th>
                    <th className={cx(TH, 'text-right')}>Cantitate</th>
                    {showReported && <th className={cx(TH, 'text-right')}>În extras</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.positions.map((p) => {
                    const off = p.reportedQuantity !== null && differs(p.quantity, p.reportedQuantity);
                    return (
                      <tr key={p.symbol} className="border-b border-line last:border-0">
                        <td className={cx(TD, 'max-w-72 truncate')}>
                          <span className="font-semibold">{p.symbol}</span> {p.name && <span className="text-xs text-ink-3">{p.name}</span>}
                        </td>
                        <td className={cx(TD, 'tabular text-right')}>{fmtQuantity(p.quantity)}</td>
                        {showReported && (
                          <td className={cx(TD, 'tabular text-right', off ? 'font-semibold text-warn' : 'text-ink-3')}>
                            {p.reportedQuantity === null ? '—' : fmtQuantity(p.reportedQuantity)}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {result.errors > 0 && <Notice tone="warn">{count(result.errors, 'rând nu a fost importat', 'rânduri nu au fost importate')} din cauza erorilor (vezi previzualizarea).</Notice>}
        {mismatched.length > 0 && (
          <Notice tone="warn">
            Cantitatea diferă de cea din extras pentru <strong>{mismatched.map((p) => p.symbol).join(', ')}</strong>. Cauze obișnuite: tranzacții introduse manual care apar și în extras,
            sau un split (se adaugă din pagina Tranzacții).
          </Notice>
        )}
        {result.unconfirmed.length > 0 && (
          <Notice tone="warn">
            Fără preț automat pentru <strong>{result.unconfirmed.join(', ')}</strong>: simbolul nu a fost găsit la furnizorul de prețuri. Poziția este evaluată la cost până introduci
            un preț manual (Portofoliu → creion).
          </Notice>
        )}
        {result.approximated > 0 && <p>{count(result.approximated, 'dividend a fost convertit', 'dividende au fost convertite')} aproximativ din moneda contului (vezi nota tranzacției).</p>}
      </div>
    </Card>
  );
}

function CsvResult({ result, onClose }: { result: CsvImportResult; onClose: () => void }) {
  if (result.errors.length === 0) {
    return (
      <Notice tone="accent" action={<Button size="sm" onClick={onClose}>Închide</Button>}>
        {count(result.imported, 'tranzacție importată', 'tranzacții importate')} din fișierul exportat din aplicație.
      </Notice>
    );
  }
  return (
    <Card title="Importul nu a fost efectuat" action={<Button size="sm" onClick={onClose}>Închide</Button>}>
      <p className="mb-3 text-body text-ink-2">Fișierul conține erori, așa că nu a fost salvată nicio tranzacție. Corectează rândurile de mai jos și încearcă din nou.</p>
      <ul className="max-h-72 space-y-1.5 overflow-y-auto text-body">
        {result.errors.map((e, i) => (
          <li key={i} className="rounded-md bg-loss-soft px-3 py-1.5 text-ink">
            <strong>Rândul {e.line}:</strong> {e.message}
          </li>
        ))}
      </ul>
    </Card>
  );
}
