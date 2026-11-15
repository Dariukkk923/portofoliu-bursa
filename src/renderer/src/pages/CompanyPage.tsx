/**
 * Pagina unei companii (sau a unui ETF / crypto) deschisă cu „Info” din căutare, watchlist sau cumpărare:
 * antetul cu prețul de azi, graficul prețului (mereu sus), apoi filele Știri / Rezultate financiare /
 * Despre companie și, jos, „Cumpără” și „În watchlist”. Nimic de aici nu se salvează în baza de date.
 */
import { useState } from 'react';
import { ArrowLeft, Building2, ExternalLink, Eye, ShoppingCart } from 'lucide-react';
import { ASSET_CURRENCIES, type SymbolHistoryRange } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { NewsFeedView } from '../components/news';
import { FinancialsView } from '../components/financials';
import { PurchaseForm } from '../components/PurchaseForm';
import { ChartBlock, RANGE_TEXT, fmtPrice, useNarrow, useSymbolHistory, type CompanyRef } from '../components/SymbolPreview';
import { TickerLogo } from '../components/TickerLogo';
import { Button, Card, EmptyState, IconButton, ListSkeleton, LoadError, Pnl, Segmented, Skeleton } from '../components/ui';
import { money, signedPercent } from '../lib/format';

type Tab = 'news' | 'financials' | 'about';
const TABS: { value: Tab; label: string }[] = [
  { value: 'news', label: 'Știri' },
  { value: 'financials', label: 'Rezultate financiare' },
  { value: 'about', label: 'Despre companie' }
];

export function CompanyPage({ company, onBack }: { company: CompanyRef; onBack: () => void }) {
  const { settings, notify, bumpData } = useApp();
  const narrow = useNarrow();
  const [tab, setTab] = useState<Tab>('news');
  const [range, setRange] = useState<SymbolHistoryRange>('6M');
  const [buying, setBuying] = useState(false);
  const [adding, setAdding] = useState(false);
  const chart = useSymbolHistory(company, range);
  // Prețul și variația de azi vin din istoricul zilnic (același cache, deci fără cerere în plus).
  const today = useSymbolHistory(company, '1M');
  const profile = useLoad(() => api.financials.profile(company.symbol, company.type), [company.symbol, company.type]);
  const assets = useLoad(() => (buying ? api.assets.list() : Promise.resolve(null)), [buying]);

  const p = profile.data;
  const currency = chart.data?.currency ?? today.data?.currency ?? p?.currency ?? company.currency ?? null;
  const name = p?.name || company.name || company.symbol;
  const facts = [p?.sector, p?.industry, p?.country].filter(Boolean).join(' · ');
  const last = today.data?.last ?? null;
  const known = (c: string | null | undefined): c is string => !!c && (ASSET_CURRENCIES as readonly string[]).includes(c);
  const assetCurrency = known(currency) ? currency : (settings?.baseCurrency ?? 'USD');

  const addToWatchlist = async (): Promise<void> => {
    setAdding(true);
    try {
      const lists = await api.watchlists.list();
      if (!lists[0]) return;
      await api.watchlists.addItem(lists[0].id, { symbol: company.symbol, type: company.type, currency: assetCurrency, name: p?.name || company.name || '' });
      notify('success', `${company.symbol.toUpperCase()} a fost adăugat în listă.`);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <IconButton label="Înapoi" onClick={onBack} className="shrink-0">
          <ArrowLeft className="size-5" />
        </IconButton>
        <TickerLogo symbol={company.symbol} type={company.type} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-bold tracking-tight text-ink max-md:text-lg">
            {name} <span className="font-semibold text-ink-3">{company.symbol.toUpperCase()}</span>
          </h2>
          <p className="truncate text-body text-ink-2">
            {facts || (profile.loading ? ' ' : [ASSET_TYPE_LABEL[company.type], company.exchange ?? p?.exchange].filter(Boolean).join(' · '))}
          </p>
        </div>
        <div className="text-right max-md:basis-full max-md:text-left">
          {last !== null ? (
            <>
              <p className="tabular text-2xl font-bold tracking-tight text-ink">{fmtPrice(last, currency)}</p>
              {today.data?.dayChange !== null && today.data?.dayChange !== undefined && (
                <Pnl value={today.data.dayChange} className="text-body font-semibold">
                  {signedPercent(today.data.dayChange)} azi
                </Pnl>
              )}
            </>
          ) : today.loading ? (
            <Skeleton className="h-8 w-36" />
          ) : null}
        </div>
      </header>

      <Card>
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          {chart.data?.change !== null && chart.data?.change !== undefined ? (
            <>
              <Pnl value={chart.data.change} className="text-md font-bold">
                {signedPercent(chart.data.change)}
              </Pnl>
              <span className="text-body text-ink-3">
                {RANGE_TEXT[range]}
                {chart.data.fx && last !== null && <> · 1 cotație = {money(last * chart.data.fx.rate, chart.data.fx.currency)}</>}
              </span>
            </>
          ) : (
            <span className="text-body text-ink-3">{RANGE_TEXT[range]}</span>
          )}
        </div>
        <ChartBlock data={chart.data} loading={chart.loading} range={range} onRange={setRange} height={narrow ? 200 : 280} />
      </Card>

      {/* Pe telefon filele rămân pe un rând (se derulează lateral dacă nu încap). */}
      <div className="-mx-1 overflow-x-auto px-1 py-1 [&>div]:flex-nowrap">
        <Segmented value={tab} onChange={setTab} options={TABS} />
      </div>

      {tab === 'news' && <NewsFeedView key={company.symbol} symbol={company.symbol} type={company.type} portfolioOnly={false} />}
      {tab === 'financials' && <FinancialsView key={company.symbol} symbol={company.symbol} type={company.type} onShowNews={() => setTab('news')} />}
      {tab === 'about' &&
        (p ? (
          p.error && !p.name && !p.description ? (
            <LoadError message={p.error} onRetry={profile.reload} />
          ) : (
            <About profile={p} />
          )
        ) : profile.error ? (
          <LoadError message={profile.error} onRetry={profile.reload} />
        ) : (
          <ListSkeleton rows={4} />
        ))}

      <div className="sticky bottom-0 z-10 -mx-4 flex gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur max-md:bottom-[calc(3.75rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
        <Button variant="primary" icon={<ShoppingCart className="size-4" />} onClick={() => setBuying(true)} className="max-md:flex-1">
          Cumpără
        </Button>
        <Button icon={<Eye className="size-4" />} onClick={() => void addToWatchlist()} loading={adding} className="max-md:flex-1">
          În watchlist
        </Button>
      </div>

      {buying && assets.data && (
        <PurchaseForm
          assets={assets.data}
          preset={{ type: company.type, symbol: company.symbol, name: p?.name || company.name || undefined, currency: assetCurrency }}
          onClose={() => setBuying(false)}
          onSaved={() => {
            setBuying(false);
            bumpData();
          }}
        />
      )}
    </div>
  );
}

function About({ profile: p }: { profile: NonNullable<Awaited<ReturnType<typeof api.financials.profile>>> }) {
  const { notify } = useApp();
  const rows: [string, string | null][] = [
    ['Sector', p.sector],
    ['Industrie', p.industry],
    ['Țara', p.country],
    ['Bursa', p.exchange],
    ['Moneda', p.currency],
    ['Emitent', p.fundFamily],
    ['Angajați', p.employees !== null ? p.employees.toLocaleString('ro-RO') : null]
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  if (shown.length === 0 && !p.description && !p.website) {
    return <EmptyState icon={<Building2 className="size-5" />} title="Fără informații" text={p.offline ? 'Fără conexiune la internet. Încearcă mai târziu.' : 'Providerul nu are informații despre acest simbol.'} />;
  }
  return (
    <Card>
      {shown.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-3">
          {shown.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-ink-3">{label}</dt>
              <dd className="truncate text-body font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.website && (
        <button
          type="button"
          onClick={() => api.news.open(p.website!).catch((err) => notify('error', errorMessage(err)))}
          className="mt-4 inline-flex items-center gap-1.5 text-body font-medium text-accent hover:underline max-md:min-h-11"
        >
          {new URL(p.website).hostname.replace(/^www\./, '')} <ExternalLink className="size-3.5" aria-hidden />
        </button>
      )}
      {p.description && <p className="mt-4 text-body leading-relaxed whitespace-pre-line text-ink-2">{p.description}</p>}
    </Card>
  );
}
