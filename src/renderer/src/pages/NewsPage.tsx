/**
 * Știri și raportări pentru activele din portofoliu și din watchlist: filtru (toate, doar portofoliul
 * sau un simbol), știrile cu miniatură și link către articol, calendarul raportărilor și raportările
 * financiare ale simbolului ales.
 */
import { useState } from 'react';
import { Eye, Newspaper, Wallet } from 'lucide-react';
import type { AssetType, EarningsCalendarEntry } from '@shared/types';
import { api } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { AssetDetailModal, Tabs, type AssetRef } from '../components/AssetDetail';
import type { PageId } from '../components/Layout';
import { EarningsCalendarView, FinancialsView } from '../components/financials';
import { NewsFeedView } from '../components/news';
import { Button, EmptyState, Select } from '../components/ui';

type Section = 'news' | 'reports';
const SECTIONS: { value: Section; label: string }[] = [
  { value: 'news', label: 'Știri' },
  { value: 'reports', label: 'Raportări financiare' }
];

const ALL = '__all__';
const HELD = '__held__';

export function NewsPage({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  const { dataVersion } = useApp();
  const symbols = useLoad(() => api.news.symbols(), [dataVersion]);
  const [section, setSection] = useState<Section>('news');
  const [choice, setChoice] = useState(ALL);
  const [detail, setDetail] = useState<AssetRef | null>(null);

  const list = symbols.data ?? [];
  const picked = list.find((s) => s.symbol === choice) ?? null;
  // Un simbol care a dispărut din portofoliu sau din watchlist nu mai poate fi ales.
  const symbol = picked ? picked.symbol : null;
  const portfolioOnly = choice === HELD;

  const empty = (
    <EmptyState
      icon={<Newspaper className="size-5" />}
      title="Nu sunt active de urmărit"
      text="Adaugă un activ în portofoliu sau în watchlist ca să vezi știrile și raportările lui."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon={<Wallet className="size-4" />} onClick={() => onNavigate('positions')}>
            Mergi la Portofoliu
          </Button>
          <Button icon={<Eye className="size-4" />} onClick={() => onNavigate('watchlist')}>
            Mergi la Watchlist
          </Button>
        </div>
      }
    />
  );

  if (symbols.data && list.length === 0) return empty;

  const held = list.filter((s) => s.held);
  const watched = list.filter((s) => !s.held);
  const open = (e: EarningsCalendarEntry): void => setDetail({ symbol: e.symbol, name: e.name, type: e.type as AssetType });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Filtru știri" className="w-64! max-md:w-full!" value={picked ? choice : choice === HELD ? HELD : ALL} onChange={(e) => setChoice(e.target.value)}>
          <option value={ALL}>Toate activele</option>
          <option value={HELD}>Doar portofoliul</option>
          {held.length > 0 && (
            <optgroup label="Din portofoliu">
              {held.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol}
                  {s.name ? ` · ${s.name}` : ''}
                </option>
              ))}
            </optgroup>
          )}
          {watched.length > 0 && (
            <optgroup label="Din watchlist">
              {watched.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol}
                  {s.name ? ` · ${s.name}` : ''}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>

      <Tabs value={section} onChange={setSection} tabs={SECTIONS} label="Știri și raportări" />

      {section === 'news' ? (
        <NewsFeedView key={`${symbol}|${portfolioOnly}`} symbol={symbol} portfolioOnly={portfolioOnly} empty={empty} />
      ) : picked ? (
        <FinancialsView key={picked.symbol} symbol={picked.symbol} type={picked.type} onShowNews={() => setSection('news')} />
      ) : (
        <EarningsCalendarView key={`${portfolioOnly}`} filter={{ portfolioOnly }} onOpen={open} empty={empty} />
      )}

      {detail && <AssetDetailModal asset={detail} initialTab="financials" onClose={() => setDetail(null)} />}
    </>
  );
}
