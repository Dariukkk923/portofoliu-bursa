/** Lista de știri (pagina Știri și fila „Știri” din detaliul unui activ): miniatură, titlu, sursă, oră, link către articol. */
import { useRef, type ReactNode } from 'react';
import { ExternalLink, Newspaper, RefreshCw } from 'lucide-react';
import type { NewsItem } from '@shared/types';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { timeAgo } from '../lib/research';
import { Badge, Button, Card, EmptyState, ListSkeleton, LoadError, Notice } from './ui';

function NewsCard({ item, showSymbols, onOpen }: { item: NewsItem; showSymbols: boolean; onOpen: (url: string) => void }) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-ink-3 max-md:size-14">
        {item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" draggable={false} className="size-full object-cover" /> : <Newspaper className="size-5" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => onOpen(item.url)} className="text-left text-body font-semibold text-ink hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
          {item.title}
        </button>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
          <span className="font-medium text-ink-2">{item.source}</span>
          <span aria-hidden>·</span>
          <time dateTime={item.publishedAt} title={dateTime(item.publishedAt)}>
            {timeAgo(item.publishedAt)}
          </time>
        </p>
        {item.summary && <p className="mt-1 line-clamp-2 text-body text-ink-2 max-md:hidden">{item.summary}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {showSymbols && item.symbols.slice(0, 4).map((s) => <Badge key={s}>{s}</Badge>)}
          <button type="button" onClick={() => onOpen(item.url)} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline max-md:min-h-8">
            Articolul original <ExternalLink className="size-3" aria-hidden />
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * Știrile pentru filtrul dat. Cât timp se încarcă: schelet; la eroare: „Încearcă din nou”;
 * fără internet: știrile salvate, cu o avertizare.
 */
export function NewsFeedView({ symbol, portfolioOnly, empty }: { symbol: string | null; portfolioOnly: boolean; empty?: ReactNode }) {
  const { notify } = useApp();
  const forceNext = useRef(false);
  const feed = useLoad(() => {
    const force = forceNext.current;
    forceNext.current = false;
    return api.news.list({ symbol, portfolioOnly, force });
  }, [symbol, portfolioOnly]);
  const refresh = (): void => {
    forceNext.current = true;
    feed.reload();
  };
  const open = (url: string): void => {
    api.news.open(url).catch((err) => notify('error', errorMessage(err)));
  };

  const data = feed.data;
  if (!data) return feed.error ? <LoadError message={feed.error} onRetry={refresh} /> : <ListSkeleton rows={6} />;
  if (data.symbolCount === 0) return <>{empty ?? <EmptyState icon={<Newspaper className="size-5" />} title="Nu sunt active de urmărit" text="Adaugă un activ în portofoliu sau în watchlist ca să vezi știrile lui." />}</>;
  if (data.error && data.items.length === 0) return <LoadError message={data.error} onRetry={refresh} />;

  return (
    <div className="space-y-3">
      {data.stale && (
        <Notice tone="warn">
          {data.offline ? 'Fără conexiune la internet.' : 'Nu am putut actualiza știrile.'} Se afișează cele salvate{data.fetchedAt ? ` (${dateTime(data.fetchedAt)})` : ''}.
        </Notice>
      )}
      <Card
        padded={false}
        title={`${data.items.length} ${data.items.length === 1 ? 'știre' : 'știri'}`}
        action={
          <Button size="sm" variant="ghost" onClick={refresh} loading={feed.loading} icon={<RefreshCw className="size-4" />}>
            Reîmprospătează
          </Button>
        }
      >
        {data.items.length === 0 ? (
          <EmptyState
            icon={<Newspaper className="size-5" />}
            title="Nu am găsit știri"
            text="Nu există articole recente pentru aceste active."
            action={
              <Button onClick={refresh} icon={<RefreshCw className="size-4" />}>
                Încearcă din nou
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((item) => (
              <NewsCard key={item.id} item={item} showSymbols={!symbol} onOpen={open} />
            ))}
          </ul>
        )}
        {data.fetchedAt && <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">Actualizat la {dateTime(data.fetchedAt)}. Știrile se reîmprospătează la cel mult 30 de minute.</p>}
      </Card>
    </div>
  );
}
