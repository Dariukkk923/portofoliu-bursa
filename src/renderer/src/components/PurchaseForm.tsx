/**
 * Formularul „Adaugă activ”: alege tipul și simbolul (cu căutare la provider),
 * completează achiziția, iar aplicația creează activul (dacă e nou) și o
 * tranzacție de tip Cumpărare.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { ASSET_CURRENCIES, ASSET_TYPES, type Asset, type AssetType, type SymbolSearchResult } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { parseNumberLoose } from '@shared/csv';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { money } from '../lib/format';
import { Badge, Button, Field, Input, Modal, Notice, Segmented, Select, Spinner, Textarea } from './ui';

const SYMBOL_HINT: Record<AssetType, string> = {
  stock: 'Ex.: AAPL, MSFT; pentru BVB adaugă sufixul .RO (TLV.RO, SNP.RO).',
  etf: 'Ex.: VWCE.DE, SPY, EUNL.DE.',
  crypto: 'Format monedă-valută: BTC-USD, ETH-EUR.',
  bond: 'Un cod ales de tine sau simbolul de la bursă (ex.: R2710A).'
};

const COUPON_FREQUENCIES = [
  { value: 1, label: 'Anual' },
  { value: 2, label: 'Semestrial' },
  { value: 4, label: 'Trimestrial' },
  { value: 12, label: 'Lunar' }
];

export function PurchaseForm({ assets, onClose, onSaved }: { assets: Asset[]; onClose: () => void; onSaved: () => void }) {
  const { brokers, reloadBrokers, notify, settings } = useApp();

  const [type, setType] = useState<AssetType>('stock');
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(settings?.baseCurrency ?? 'RON');
  const [brokerId, setBrokerId] = useState<number | ''>(brokers[0]?.id ?? '');
  const [newBroker, setNewBroker] = useState('');
  const [date, setDate] = useState(todayIso());
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
  const [notes, setNotes] = useState('');
  // obligațiuni
  const [faceValue, setFaceValue] = useState('100');
  const [couponRate, setCouponRate] = useState('');
  const [couponFrequency, setCouponFrequency] = useState(1);
  const [maturityDate, setMaturityDate] = useState('');
  const [manualPrice, setManualPrice] = useState('');

  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [marketPrice, setMarketPrice] = useState<{ price: number; currency: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const searchSeq = useRef(0);

  /** Activul există deja în portofoliu? Atunci tipul și moneda lui sunt fixe. */
  const existing = useMemo(() => assets.find((a) => a.symbol === symbol.trim().toUpperCase()) ?? null, [assets, symbol]);
  useEffect(() => {
    if (!existing) return;
    setType(existing.type);
    setCurrency(existing.currency);
    setName(existing.name);
  }, [existing]);

  // Căutare cu întârziere: nu trimitem câte o cerere pentru fiecare literă tastată.
  useEffect(() => {
    const query = symbol.trim();
    if (type === 'bond' || query.length < 2 || !showResults) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.prices
        .search(query)
        .then((list) => seq === searchSeq.current && setResults(list))
        .catch(() => seq === searchSeq.current && setResults([]))
        .finally(() => seq === searchSeq.current && setSearching(false));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [symbol, type, showResults]);

  /** După alegerea simbolului: aflăm moneda și prețul curent de la provider. */
  const lookup = (sym: string, assetType: AssetType): void => {
    setMarketPrice(null);
    if (assetType === 'bond' || !sym.trim()) return;
    api.prices
      .lookup(sym, assetType)
      .then((q) => {
        if (!q) return;
        setMarketPrice({ price: q.price, currency: q.currency });
        if (q.currency && (ASSET_CURRENCIES as readonly string[]).includes(q.currency)) setCurrency(q.currency);
        if (q.name) setName((current) => current || q.name || '');
      })
      .catch(() => undefined);
  };

  const pick = (r: SymbolSearchResult): void => {
    setSymbol(r.symbol);
    setName(r.name);
    if (r.type) setType(r.type);
    setShowResults(false);
    lookup(r.symbol, r.type ?? type);
  };

  const qty = parseNumberLoose(quantity);
  const unitPrice = parseNumberLoose(price);
  const feeValue = parseNumberLoose(fee) ?? 0;
  const face = parseNumberLoose(faceValue);
  const multiplier = type === 'bond' ? (face ?? 100) / 100 : 1;
  const total = qty !== null && unitPrice !== null ? qty * unitPrice * multiplier + feeValue : null;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (qty === null || unitPrice === null) {
      setError('Completează numărul de unități și prețul de cumpărare.');
      return;
    }
    setSaving(true);
    try {
      // Broker nou, creat direct din formular.
      let broker = brokerId;
      if (broker === '') {
        if (!newBroker.trim()) throw new Error('broker');
        broker = (await api.brokers.create({ name: newBroker })).id;
        await reloadBrokers();
      }
      await api.portfolio.addPurchase({
        asset: {
          type,
          symbol,
          name,
          currency,
          ...(type === 'bond'
            ? {
                faceValue: face,
                couponRate: parseNumberLoose(couponRate) ?? 0,
                couponFrequency,
                maturityDate: maturityDate || null,
                manualPrice: parseNumberLoose(manualPrice)
              }
            : {})
        },
        brokerId: broker,
        date,
        quantity: qty,
        price: unitPrice,
        fee: feeValue,
        notes
      });
      notify('success', `Achiziția ${symbol.trim().toUpperCase()} a fost adăugată și înregistrată ca tranzacție de cumpărare.`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message === 'broker' ? 'Alege un broker sau scrie numele unuia nou.' : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Adaugă activ"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          {total !== null && (
            <span className="mr-auto text-[13px] text-ink-2">
              Cost total: <strong className="tabular text-ink">{money(total, currency)}</strong>
            </span>
          )}
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="purchase-form" loading={saving}>
            Adaugă achiziția
          </Button>
        </>
      }
    >
      <form id="purchase-form" onSubmit={submit} className="space-y-4">
        <div>
          <span className="mb-1 block text-[13px] font-medium text-ink-2">Tip de activ</span>
          <Segmented
            value={type}
            onChange={(t) => {
              if (existing) return;
              setType(t);
              lookup(symbol, t);
            }}
            options={ASSET_TYPES.map((t) => ({ value: t, label: ASSET_TYPE_LABEL[t] }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Simbol / ticker" hint={SYMBOL_HINT[type]}>
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-3" aria-hidden />
              <Input
                className="pl-9 uppercase placeholder:normal-case"
                value={symbol}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  setShowResults(true);
                }}
                onBlur={() => window.setTimeout(() => setShowResults(false), 150)}
                onFocus={() => setShowResults(true)}
                placeholder={type === 'crypto' ? 'BTC-USD' : type === 'bond' ? 'R2710A' : 'Caută după nume sau simbol'}
                required
                autoFocus
                autoComplete="off"
                role="combobox"
                aria-expanded={showResults && results.length > 0}
                aria-controls="symbol-results"
              />
              {showResults && (searching || results.length > 0) && (
                <ul id="symbol-results" role="listbox" className="absolute z-10 mt-1 max-h-64 w-[150%] overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl">
                  {searching && results.length === 0 && (
                    <li className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink-3">
                      <Spinner className="size-4" /> Se caută…
                    </li>
                  )}
                  {results.map((r) => (
                    <li key={`${r.symbol}-${r.exchange}`} role="option" aria-selected={false}>
                      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2">
                        <span className="w-24 shrink-0 text-[13px] font-semibold text-ink">{r.symbol}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{r.name}</span>
                        {r.exchange && <span className="shrink-0 text-xs text-ink-3">{r.exchange}</span>}
                        {r.type && <Badge>{ASSET_TYPE_LABEL[r.type]}</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>
          <Field label="Denumire (opțional)">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={!!existing} />
          </Field>
        </div>

        {existing && (
          <Notice tone="accent">
            {existing.symbol} există deja în portofoliu ({ASSET_TYPE_LABEL[existing.type]}, {existing.currency}). Achiziția se adaugă la poziția existentă.
          </Notice>
        )}

        {type === 'bond' && !existing && (
          <fieldset className="grid grid-cols-4 gap-3.5 rounded-lg border border-line p-3.5">
            <legend className="px-1 text-xs font-semibold text-ink-3">Detalii obligațiune</legend>
            <Field label="Valoare nominală">
              <Input inputMode="decimal" value={faceValue} onChange={(e) => setFaceValue(e.target.value)} required />
            </Field>
            <Field label="Rată cupon (% pe an)">
              <Input inputMode="decimal" value={couponRate} onChange={(e) => setCouponRate(e.target.value)} placeholder="7,2" />
            </Field>
            <Field label="Frecvență cupon">
              <Select value={couponFrequency} onChange={(e) => setCouponFrequency(Number(e.target.value))}>
                {COUPON_FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Data scadenței">
              <Input type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
            </Field>
            <Field label="Preț curent (% din nominal)" hint="Opțional. Pentru titlurile fără preț în API îl poți actualiza oricând manual." className="col-span-4">
              <Input inputMode="decimal" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} placeholder="ex.: 101,4" className="max-w-40" />
            </Field>
          </fieldset>
        )}

        <div className="grid grid-cols-3 gap-3.5">
          <Field label="Număr de unități" hint="Acceptă zecimale (ex.: 0,035).">
            <Input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} required placeholder="0" />
          </Field>
          <Field
            label={type === 'bond' ? 'Preț de cumpărare (% din nominal)' : 'Preț de cumpărare / unitate'}
            hint={
              marketPrice ? (
                <button type="button" className="text-accent hover:underline" onClick={() => setPrice(String(marketPrice.price).replace('.', ','))}>
                  Preț curent: {marketPrice.price.toLocaleString('ro-RO', { maximumFractionDigits: 6 })} {marketPrice.currency ?? ''}
                </button>
              ) : undefined
            }
          >
            <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="0,00" />
          </Field>
          <Field label="Monedă">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!!existing}>
              {ASSET_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Data achiziției">
            <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Broker">
            <Select value={brokerId} onChange={(e) => setBrokerId(e.target.value ? Number(e.target.value) : '')}>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              <option value="">+ Broker nou…</option>
            </Select>
          </Field>
          <Field label="Comision">
            <Input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0,00" />
          </Field>
          {brokerId === '' && (
            <Field label="Numele brokerului nou" className="col-span-3">
              <Input value={newBroker} onChange={(e) => setNewBroker(e.target.value)} placeholder="ex.: XTB, Tradeville, Revolut, Binance" maxLength={60} />
            </Field>
          )}
        </div>

        <Field label="Note (opțional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>

        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}
