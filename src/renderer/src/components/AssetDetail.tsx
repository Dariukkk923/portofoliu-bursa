/** Detaliul unui activ: o fereastră cu filele „Știri” și „Raportări financiare”, deschisă din simbolul unei poziții sau al unui rând din watchlist. */
import { useState } from 'react';
import { Newspaper } from 'lucide-react';
import type { AssetType } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { TickerLogo } from './TickerLogo';
import { FinancialsView } from './financials';
import { NewsFeedView } from './news';
import { Badge, EmptyState, Modal, cx } from './ui';

export interface AssetRef {
  symbol: string;
  name: string;
  type: AssetType;
}

export type DetailTab = 'news' | 'financials';

/** Fila selectată se vede și din culoare, și din `aria-selected`. */
export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px border-b-2 px-3 py-2 text-body font-medium whitespace-nowrap transition max-md:min-h-11',
            t.value === value ? 'border-accent text-accent' : 'border-transparent text-ink-2 hover:text-ink'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const RESEARCH_TABS: { value: DetailTab; label: string }[] = [
  { value: 'news', label: 'Știri' },
  { value: 'financials', label: 'Raportări financiare' }
];

/** Simbolul ca buton care deschide detaliul; restul acțiunilor din rând rămân neschimbate. */
export function SymbolButton({ symbol, onClick, className }: { symbol: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} title={`Știri și raportări pentru ${symbol}`} className={cx('font-semibold text-ink hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent', className)}>
      {symbol}
    </button>
  );
}

export function AssetDetailModal({ asset, initialTab = 'news', onClose }: { asset: AssetRef; initialTab?: DetailTab; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  return (
    <Modal title={asset.symbol} width="max-w-3xl" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2.5">
        <TickerLogo symbol={asset.symbol} type={asset.type} size={32} />
        <p className="min-w-0 flex-1 truncate text-body text-ink-2">{asset.name || ASSET_TYPE_LABEL[asset.type]}</p>
        <Badge>{ASSET_TYPE_LABEL[asset.type]}</Badge>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={RESEARCH_TABS} label={`Detalii ${asset.symbol}`} />
      <div className="pt-4">
        {tab === 'news' ? (
          asset.type === 'bond' ? (
            <EmptyState icon={<Newspaper className="size-5" />} title="Fără știri" text="Pentru obligațiuni nu există știri." />
          ) : (
            <NewsFeedView symbol={asset.symbol} portfolioOnly={false} />
          )
        ) : <FinancialsView symbol={asset.symbol} type={asset.type} onShowNews={() => setTab('news')} />}
      </div>
    </Modal>
  );
}
