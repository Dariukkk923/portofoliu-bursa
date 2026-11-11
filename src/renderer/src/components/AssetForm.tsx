/** Editarea unui activ: denumire, sursa prețului (API sau manual), prețul manual, sectorul și țara, termenii obligațiunii. */
import { useState, type FormEvent } from 'react';
import type { Asset, AssetUpdate, PriceMode } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { parseNumberLoose } from '@shared/csv';
import { couponPerPayment, nextCouponDate } from '@shared/calc/bonds';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { date as fmtDate, money } from '../lib/format';
import { Button, Field, Input, Modal, Notice, Segmented, Select } from './ui';

const toText = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n).replace('.', ','));

export function AssetForm({ asset, onClose, onSaved }: { asset: Asset; onClose: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const isBond = asset.type === 'bond';
  const [name, setName] = useState(asset.name);
  const [priceMode, setPriceMode] = useState<PriceMode>(asset.priceMode);
  const [manualPrice, setManualPrice] = useState(toText(asset.manualPrice));
  const [faceValue, setFaceValue] = useState(toText(asset.faceValue));
  const [couponRate, setCouponRate] = useState(toText(asset.couponRate));
  const [couponFrequency, setCouponFrequency] = useState(asset.couponFrequency ?? 1);
  const [maturityDate, setMaturityDate] = useState(asset.maturityDate ?? '');
  const [sector, setSector] = useState(asset.sector ?? '');
  const [country, setCountry] = useState(asset.country ?? '');
  const profileChanged = sector.trim() !== (asset.sector ?? '') || country.trim() !== (asset.country ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Informații orientative despre cupon, calculate din termenii introduși.
  const face = parseNumberLoose(faceValue);
  const rate = parseNumberLoose(couponRate);
  const coupon = isBond && face && rate ? couponPerPayment({ faceValue: face, couponRate: rate, couponFrequency }) : null;
  const nextCoupon = isBond && maturityDate ? nextCouponDate({ couponFrequency, maturityDate }, todayIso()) : null;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const manual = manualPrice.trim() === '' ? null : parseNumberLoose(manualPrice);
    if (manualPrice.trim() !== '' && manual === null) return setError('Prețul manual nu este un număr valid.');
    if (priceMode === 'manual' && manual === null) return setError('Pentru modul manual trebuie să introduci un preț.');
    const patch: AssetUpdate = { name, priceMode, manualPrice: manual };
    // Sectorul și țara se trimit doar dacă au fost schimbate (altfel rămân cele de la provider).
    if (profileChanged) {
      patch.sector = sector;
      patch.country = country;
    }
    if (isBond) {
      patch.faceValue = face;
      patch.couponRate = rate ?? 0;
      patch.couponFrequency = couponFrequency;
      patch.maturityDate = maturityDate || null;
    }
    setSaving(true);
    try {
      await api.assets.update(asset.id, patch);
      notify('success', `${asset.symbol} a fost actualizat.`);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${asset.symbol} — ${ASSET_TYPE_LABEL[asset.type]}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="asset-form" loading={saving}>
            Salvează
          </Button>
        </>
      }
    >
      <form id="asset-form" onSubmit={submit} className="space-y-4">
        <Field label="Denumire">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>

        <div>
          <span className="mb-1 block text-body font-medium text-ink-2">Sursa prețului curent</span>
          <Segmented
            value={priceMode}
            onChange={setPriceMode}
            options={[
              { value: 'auto', label: 'Automat (din API)' },
              { value: 'manual', label: 'Manual' }
            ]}
          />
          <p className="mt-1.5 text-xs text-ink-3">
            {priceMode === 'auto'
              ? 'Prețul se ia de la providerul de date. Dacă nu este disponibil, se folosește ultimul preț introdus manual.'
              : 'Se folosește doar prețul introdus de tine (util pentru titlurile de stat, care nu apar în API-uri).'}
          </p>
        </div>

        {asset.type !== 'crypto' && (
          <div className="grid grid-cols-2 gap-3.5">
            <Field
              label={asset.type === 'etf' ? 'Categorie (ETF)' : 'Sector'}
              hint={
                asset.profileSource === 'api'
                  ? 'Primit de la providerul de date; îl poți schimba.'
                  : asset.type === 'etf'
                    ? 'ex.: Acțiuni globale, Obligațiuni, S&P 500'
                    : 'ex.: Tehnologie, Energie, Servicii financiare'
              }
            >
              <Input value={sector} onChange={(e) => setSector(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Țara" hint={asset.type === 'etf' ? 'Lasă gol pentru un ETF pe mai multe țări.' : 'ex.: SUA, România, Germania'}>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={60} />
            </Field>
          </div>
        )}

        <Field
          label={isBond ? 'Preț manual (% din nominal)' : `Preț manual (${asset.currency})`}
          hint={asset.manualPriceDate ? `Ultima actualizare manuală: ${fmtDate(asset.manualPriceDate)}` : 'Lasă gol dacă nu vrei un preț manual.'}
        >
          <Input inputMode="decimal" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} placeholder={isBond ? 'ex.: 101,4' : '0,00'} className="max-w-48" />
        </Field>

        {isBond && (
          <fieldset className="grid grid-cols-2 gap-3.5 rounded-lg border border-line p-3.5">
            <legend className="px-1 text-xs font-semibold text-ink-3">Detalii obligațiune</legend>
            <Field label={`Valoare nominală (${asset.currency})`}>
              <Input inputMode="decimal" value={faceValue} onChange={(e) => setFaceValue(e.target.value)} required />
            </Field>
            <Field label="Rată cupon (% pe an)">
              <Input inputMode="decimal" value={couponRate} onChange={(e) => setCouponRate(e.target.value)} />
            </Field>
            <Field label="Frecvență cupon">
              <Select value={couponFrequency} onChange={(e) => setCouponFrequency(Number(e.target.value))}>
                <option value={1}>Anual</option>
                <option value={2}>Semestrial</option>
                <option value={4}>Trimestrial</option>
                <option value={12}>Lunar</option>
              </Select>
            </Field>
            <Field label="Data scadenței">
              <Input type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
            </Field>
            {(coupon !== null || nextCoupon) && (
              <p className="col-span-2 text-xs text-ink-2">
                {coupon !== null && <>Cupon brut pe plată: {money(coupon, asset.currency)} / obligațiune. </>}
                {nextCoupon && <>Următorul cupon: {fmtDate(nextCoupon)}.</>}
              </p>
            )}
          </fieldset>
        )}

        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}
