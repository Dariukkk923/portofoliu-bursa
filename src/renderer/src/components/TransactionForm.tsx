/** Formularul de adăugare/editare a unei tranzacții (cumpărare, vânzare, dividend, cupon, split). */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { TRANSACTION_TYPES, type Asset, type PositionView, type TransactionInput, type TransactionType, type TransactionView } from '@shared/types';
import { ASSET_TYPE_LABEL, TRANSACTION_TYPE_LABEL } from '@shared/labels';
import { parseNumberLoose } from '@shared/csv';
import { parseSplitRatio } from '@shared/calc/engine';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { money, quantity as fmtQuantity } from '../lib/format';
import { Button, Field, Input, Modal, Notice, Select, Textarea } from './ui';

/** Număr -> text editabil, cu virgulă zecimală. */
const toText = (n: number | null | undefined): string => (n === null || n === undefined || n === 0 ? '' : String(n).replace('.', ','));

/** Tipurile de tranzacție permise pentru un activ: cupon doar la obligațiuni, dividend și split doar la restul. */
function allowedTypes(asset: Asset | undefined): TransactionType[] {
  if (!asset) return TRANSACTION_TYPES;
  return TRANSACTION_TYPES.filter((t) => (asset.type === 'bond' ? t !== 'dividend' && t !== 'split' : t !== 'coupon'));
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
  preset?: { type?: TransactionType; assetId?: number; brokerId?: number | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { brokers, notify } = useApp();
  const [assetId, setAssetId] = useState<number | ''>(initial?.assetId ?? preset?.assetId ?? assets[0]?.id ?? '');
  const [type, setType] = useState<TransactionType>(initial?.type ?? preset?.type ?? 'buy');
  const [brokerId, setBrokerId] = useState<number | ''>(initial ? (initial.brokerId ?? '') : (preset?.brokerId ?? brokers[0]?.id ?? ''));
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [quantity, setQuantity] = useState(toText(initial?.quantity));
  const [price, setPrice] = useState(initial && (initial.type === 'buy' || initial.type === 'sell') ? String(initial.price).replace('.', ',') : '');
  const [fee, setFee] = useState(toText(initial?.fee));
  const [gross, setGross] = useState(toText(initial?.grossAmount));
  const [tax, setTax] = useState(toText(initial?.taxWithheld));
  const [ratio, setRatio] = useState(initial?.type === 'split' ? `${initial.splitNumerator}:${initial.splitDenominator}` : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const asset = assets.find((a) => a.id === assetId);
  const types = useMemo(() => allowedTypes(asset), [asset]);
  useEffect(() => {
    if (!types.includes(type)) setType('buy');
  }, [types, type]);
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
  const available = positions.find((p) => p.assetId === assetId && p.brokerId === brokerId)?.quantity ?? 0;

  const isTrade = type === 'buy' || type === 'sell';
  const isIncome = type === 'dividend' || type === 'coupon';
  const grossValue = parseNumberLoose(gross);
  const taxValue = parseNumberLoose(tax) ?? 0;
  const net = grossValue !== null ? grossValue - taxValue : null;
  const currency = asset?.currency ?? '';

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (assetId === '') return setError('Alege activul.');
    const input: TransactionInput = { assetId, brokerId: brokerId === '' ? null : brokerId, type, date, notes };
    if (isTrade) {
      input.quantity = parseNumberLoose(quantity) ?? undefined;
      input.price = parseNumberLoose(price) ?? undefined;
      input.fee = parseNumberLoose(fee) ?? 0;
      if (input.quantity === undefined || input.price === undefined) return setError('Completează cantitatea și prețul.');
    } else if (isIncome) {
      if (grossValue === null) return setError('Completează suma brută.');
      input.grossAmount = grossValue;
      input.taxWithheld = taxValue;
    } else {
      const parsed = parseSplitRatio(ratio);
      if (!parsed) return setError('Scrie raportul de split în forma „4:1” (4 acțiuni noi pentru 1 veche).');
      input.splitNumerator = parsed.numerator;
      input.splitDenominator = parsed.denominator;
    }
    setSaving(true);
    try {
      if (initial) await api.transactions.update(initial.id, input);
      else await api.transactions.create(input);
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
          <Button variant="primary" type="submit" form="tx-form" loading={saving} disabled={assets.length === 0}>
            {initial ? 'Salvează modificările' : 'Adaugă tranzacția'}
          </Button>
        </>
      }
    >
      {assets.length === 0 ? (
        <Notice tone="accent">Nu ai încă niciun activ. Adaugă primul activ din pagina Portofoliu („Adaugă activ”), apoi poți înregistra vânzări, dividende sau split-uri.</Notice>
      ) : (
        <form id="tx-form" onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3.5">
            <Field label="Activ">
              <Select value={assetId} onChange={(e) => setAssetId(Number(e.target.value))}>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol} — {ASSET_TYPE_LABEL[a.type]}, {a.currency}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tip tranzacție">
              <Select value={type} onChange={(e) => setType(e.target.value as TransactionType)}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {TRANSACTION_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
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

          {type === 'split' && (
            <Field label="Raport de split" hint="„4:1” = 4 acțiuni noi pentru fiecare acțiune veche; „1:10” = split invers. Cantitatea și prețul mediu se ajustează automat, valoarea investită rămâne aceeași.">
              <Input value={ratio} onChange={(e) => setRatio(e.target.value)} placeholder="4:1" className="max-w-40" required />
            </Field>
          )}

          <Field label="Note (opțional)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </Field>

          {error && <Notice tone="loss">{error}</Notice>}
        </form>
      )}
    </Modal>
  );
}
