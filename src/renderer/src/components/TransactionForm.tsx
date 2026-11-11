/**
 * Formularul de adăugare/editare a unei tranzacții: cu activ (cumpărare, vânzare,
 * dividend, cupon, split) sau de cash (depunere, retragere, comision, dobândă, ajustare de sold).
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ASSET_CURRENCIES,
  ASSET_TRANSACTION_TYPES,
  CASH_TRANSACTION_TYPES,
  type Asset,
  type PositionView,
  type TransactionInput,
  type TransactionType,
  type TransactionView
} from '@shared/types';
import { ASSET_TYPE_LABEL, TRANSACTION_TYPE_LABEL } from '@shared/labels';
import { parseNumberLoose } from '@shared/csv';
import { parseSplitRatio } from '@shared/calc/engine';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { money, quantity as fmtQuantity } from '../lib/format';
import { Button, Field, Input, Modal, Notice, Select, Textarea } from './ui';
import { PortfolioField } from './portfolio';
import { JournalSection, SellPlanBox, draftError, draftIsEmpty, draftToInput, emptyDraft, type JournalDraft } from './journal';

/** Număr -> text editabil, cu virgulă zecimală. */
const toText = (n: number | null | undefined): string => (n === null || n === undefined || n === 0 ? '' : String(n).replace('.', ','));

/** Tipurile de tranzacție permise pentru un activ: cupon doar la obligațiuni, dividend și split doar la restul. */
function allowedAssetTypes(asset: Asset | undefined): TransactionType[] {
  if (!asset) return ASSET_TRANSACTION_TYPES;
  return ASSET_TRANSACTION_TYPES.filter((t) => (asset.type === 'bond' ? t !== 'dividend' && t !== 'split' : t !== 'coupon'));
}

const CASH_HINT: Partial<Record<TransactionType, string>> = {
  deposit: 'Bani transferați în contul de la broker.',
  withdrawal: 'Bani retrași din contul de la broker.',
  fee: 'Comision sau taxă care nu ține de o anumită cumpărare/vânzare (ex.: taxă de custodie, de inactivitate).',
  interest: 'Dobânda primită pentru banii neinvestiți din cont.',
  adjustment: 'Corectează soldul de cash când nu se potrivește cu cel de la broker. Pune minus pentru o scădere.'
};

export interface TransactionPreset {
  portfolioId?: number | null;
  type?: TransactionType;
  assetId?: number | null;
  brokerId?: number | null;
  currency?: string;
  amount?: number;
  /** Data și sumele unui dividend propus din calendar. */
  date?: string;
  gross?: number;
  tax?: number;
  notes?: string;
}

export function TransactionForm({
  assets,
  initial,
  preset,
  onClose,
  onSaved
}: {
  assets: Asset[];
  /** Tranzacția editată; null pentru una nouă. */
  initial: TransactionView | null;
  /** Valori precompletate pentru o tranzacție nouă (ex.: „Vinde” din pagina Portofoliu). */
  preset?: TransactionPreset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { brokers, notify, settings, defaultPortfolioId } = useApp();
  const [portfolioId, setPortfolioId] = useState<number | null>(initial?.portfolioId ?? preset?.portfolioId ?? defaultPortfolioId);
  const [type, setType] = useState<TransactionType>(initial?.type ?? preset?.type ?? (assets.length > 0 ? 'buy' : 'deposit'));
  const [assetId, setAssetId] = useState<number | ''>(initial?.assetId ?? preset?.assetId ?? (type === 'fee' ? '' : (assets[0]?.id ?? '')));
  const [brokerId, setBrokerId] = useState<number | ''>(initial ? (initial.brokerId ?? '') : (preset?.brokerId ?? brokers[0]?.id ?? ''));
  const [date, setDate] = useState(initial?.date ?? preset?.date ?? todayIso());
  const [quantity, setQuantity] = useState(toText(initial?.quantity));
  const [price, setPrice] = useState(initial && (initial.type === 'buy' || initial.type === 'sell') ? String(initial.price).replace('.', ',') : '');
  const [fee, setFee] = useState(toText(initial?.fee));
  const [gross, setGross] = useState(toText(initial?.grossAmount ?? preset?.gross));
  const [tax, setTax] = useState(toText(initial?.taxWithheld ?? preset?.tax));
  const [amount, setAmount] = useState(toText(initial ? initial.netAmount : preset?.amount));
  const [cashCurrency, setCashCurrency] = useState(initial?.currency ?? preset?.currency ?? settings?.baseCurrency ?? 'RON');
  const [ratio, setRatio] = useState(initial?.type === 'split' ? `${initial.splitNumerator}:${initial.splitDenominator}` : '');
  const [notes, setNotes] = useState(initial?.notes ?? preset?.notes ?? '');
  const [journal, setJournal] = useState<JournalDraft>(emptyDraft);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isCash = CASH_TRANSACTION_TYPES.includes(type);
  // Comisionul poate privi un activ (opțional); restul tranzacțiilor de cash nu au activ.
  const usesAsset = !isCash || type === 'fee';
  const asset = usesAsset ? assets.find((a) => a.id === assetId) : undefined;
  const assetTypes = useMemo(() => allowedAssetTypes(asset), [asset]);
  useEffect(() => {
    if (!isCash && !assetTypes.includes(type)) setType('buy');
  }, [assetTypes, type, isCash]);
  // Activul ales rămâne valid când se trece de la un tip de cash înapoi la unul cu activ.
  useEffect(() => {
    if (!isCash && assetId === '' && assets.length > 0) setAssetId(assets[0].id);
  }, [isCash, assetId, assets]);
  // La split, brokerul este opțional („toți brokerii”); la restul este obligatoriu.
  useEffect(() => {
    if (type !== 'split' && brokerId === '' && brokers.length > 0) setBrokerId(brokers[0].id);
  }, [type, brokerId, brokers]);

  // Pozițiile curente, pentru a arăta cât se poate vinde la brokerul ales.
  useEffect(() => {
    api.portfolio
      .overview({})
      .then((o) => setPositions(o.positions))
      .catch(() => undefined);
  }, []);
  const available = positions.find((p) => p.assetId === assetId && p.brokerId === brokerId && p.portfolioId === portfolioId)?.quantity ?? 0;

  const isTrade = type === 'buy' || type === 'sell';
  const isIncome = type === 'dividend' || type === 'coupon' || type === 'interest';
  const grossValue = parseNumberLoose(gross);
  const taxValue = parseNumberLoose(tax) ?? 0;
  const net = grossValue !== null ? grossValue - taxValue : null;
  const currency = asset?.currency ?? cashCurrency;
  const currencies = [...new Set([...(settings ? [settings.baseCurrency] : []), ...ASSET_CURRENCIES, cashCurrency])];

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!isCash && assetId === '') return setError('Alege activul.');
    const input: TransactionInput = {
      // Split-ul se aplică în toate portofoliile.
      portfolioId: type === 'split' ? null : portfolioId,
      assetId: usesAsset && assetId !== '' ? assetId : null,
      brokerId: brokerId === '' ? null : brokerId,
      type,
      date,
      notes,
      currency: asset ? null : cashCurrency
    };
    if (isTrade) {
      input.quantity = parseNumberLoose(quantity) ?? undefined;
      input.price = parseNumberLoose(price) ?? undefined;
      input.fee = parseNumberLoose(fee) ?? 0;
      if (input.quantity === undefined || input.price === undefined) return setError('Completează cantitatea și prețul.');
      const journalInvalid = initial ? null : draftError(journal);
      if (journalInvalid) return setError(journalInvalid);
    } else if (isIncome) {
      if (grossValue === null) return setError('Completează suma brută.');
      input.grossAmount = grossValue;
      input.taxWithheld = taxValue;
    } else if (type === 'split') {
      const parsed = parseSplitRatio(ratio);
      if (!parsed) return setError('Scrie raportul de split în forma „4:1” (4 acțiuni noi pentru 1 veche).');
      input.splitNumerator = parsed.numerator;
      input.splitDenominator = parsed.denominator;
    } else {
      const value = parseNumberLoose(amount);
      if (value === null) return setError('Completează suma.');
      input.amount = value;
    }
    setSaving(true);
    try {
      if (initial) await api.transactions.update(initial.id, input);
      else {
        const tx = await api.transactions.create(input);
        // Nota din jurnal (opțională) se leagă de cumpărare/vânzare.
        if (isTrade && !draftIsEmpty(journal)) {
          await api.journal.create({ ...draftToInput(journal), transactionId: tx.id }).catch((err) =>
            notify('error', `Tranzacția a fost salvată, dar nota din jurnal nu: ${errorMessage(err)}`)
          );
        }
      }
      notify('success', initial ? 'Tranzacția a fost modificată.' : 'Tranzacția a fost adăugată.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? 'Editează tranzacția' : 'Adaugă tranzacție'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="tx-form" loading={saving} disabled={brokers.length === 0}>
            {initial ? 'Salvează modificările' : 'Adaugă tranzacția'}
          </Button>
        </>
      }
    >
      {brokers.length === 0 ? (
        <Notice tone="accent">Adaugă întâi un broker (pagina Brokeri) sau primul activ din pagina Portofoliu („Adaugă activ”).</Notice>
      ) : (
        <form id="tx-form" onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3.5">
            <Field label="Tip tranzacție">
              <Select value={type} onChange={(e) => setType(e.target.value as TransactionType)}>
                {assets.length > 0 && (
                  <optgroup label="Cu un activ">
                    {assetTypes.map((t) => (
                      <option key={t} value={t}>
                        {TRANSACTION_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Cash la broker">
                  {CASH_TRANSACTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TRANSACTION_TYPE_LABEL[t]}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </Field>
            {usesAsset ? (
              <Field label={type === 'fee' ? 'Activ (opțional)' : 'Activ'}>
                <Select value={assetId} onChange={(e) => setAssetId(e.target.value ? Number(e.target.value) : '')}>
                  {type === 'fee' && <option value="">Fără activ (comision general)</option>}
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.symbol} — {ASSET_TYPE_LABEL[a.type]}, {a.currency}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Monedă">
                <Select value={cashCurrency} onChange={(e) => setCashCurrency(e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {type !== 'split' && <PortfolioField value={portfolioId} onChange={setPortfolioId} />}
            <Field label="Broker" hint={type === 'sell' && brokerId !== '' ? `Disponibil la acest broker: ${fmtQuantity(available)}` : undefined}>
              <Select value={brokerId} onChange={(e) => setBrokerId(e.target.value ? Number(e.target.value) : '')}>
                {type === 'split' && <option value="">Toți brokerii</option>}
                {brokers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Data">
              <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            {type === 'fee' && !asset && (
              <Field label="Monedă">
                <Select value={cashCurrency} onChange={(e) => setCashCurrency(e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {isTrade && (
            <div className="grid grid-cols-3 gap-3.5">
              <Field label="Cantitate">
                <Input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" required />
              </Field>
              <Field label={asset?.type === 'bond' ? 'Preț (% din nominal)' : `Preț / unitate (${currency})`}>
                <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" required />
              </Field>
              <Field label={`Comision (${currency})`}>
                <Input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0,00" />
              </Field>
            </div>
          )}

          {isIncome && (
            <div className="grid grid-cols-3 gap-3.5">
              <Field label={`Sumă brută (${currency})`}>
                <Input inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} placeholder="0,00" required />
              </Field>
              <Field label={`Impozit reținut (${currency})`}>
                <Input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0,00" />
              </Field>
              <Field label="Sumă netă" hint="Brut minus impozit.">
                <Input value={net !== null ? money(net, currency || 'RON') : ''} readOnly disabled />
              </Field>
            </div>
          )}

          {(type === 'deposit' || type === 'withdrawal' || type === 'fee' || type === 'adjustment') && (
            <Field label={`Sumă (${currency})`} hint={CASH_HINT[type]}>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={type === 'adjustment' ? 'ex.: -12,50' : '0,00'} className="max-w-56" required />
            </Field>
          )}
          {type === 'interest' && <p className="-mt-2 text-xs text-ink-3">{CASH_HINT.interest}</p>}

          {type === 'split' && (
            <Field label="Raport de split" hint="„4:1” = 4 acțiuni noi pentru fiecare acțiune veche; „1:10” = split invers. Cantitatea și prețul mediu se ajustează automat, valoarea investită rămâne aceeași.">
              <Input value={ratio} onChange={(e) => setRatio(e.target.value)} placeholder="4:1" className="max-w-40" required />
            </Field>
          )}

          {type === 'sell' && <SellPlanBox portfolioId={portfolioId} assetId={assetId} price={parseNumberLoose(price)} date={date} />}

          <Field label="Note (opțional)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </Field>

          {!initial && isTrade && (
            <JournalSection title={type === 'buy' ? 'Notează în jurnal de ce cumperi' : 'Notează în jurnal de ce vinzi'} draft={journal} onChange={setJournal} currency={asset?.currency} />
          )}

          {error && <Notice tone="loss">{error}</Notice>}
        </form>
      )}
    </Modal>
  );
}
