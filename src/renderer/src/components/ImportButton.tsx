/**
 * Butonul „Import Excel / CSV”: utilizatorul alege un fișier, iar aplicația îi
 * recunoaște singură tipul.
 *
 *  - Fișierul Excel exportat din xStation (XTB): pozițiile, vânzările și
 *    dividendele apar în aplicație fără nimic de completat. Aplicația nu se
 *    conectează la contul XTB și nu cere parola lui; citește doar fișierul.
 *    O singură întrebare poate apărea: dacă există deja tranzacții introduse
 *    manual la XTB pentru aceleași instrumente (ar apărea de două ori). La
 *    final se afișează ce s-a importat și ce a rămas de verificat.
 *  - Un CSV exportat din această aplicație: tranzacțiile se importă direct.
 */
import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import type { BrokerImportPreview, BrokerImportResult, CsvImportResult } from '@shared/types';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { quantity as fmtQuantity } from '../lib/format';
import { Button, Modal, Notice, TD, TH, cx } from './ui';

/** „1 tranzacție”, „5 tranzacții”, „25 de tranzacții”. */
function count(n: number, one: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const lastTwo = n % 100;
  return `${n} ${n >= 20 && (lastTwo === 0 || lastTwo >= 20) ? 'de ' : ''}${many}`;
}

const differs = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

export function ImportButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const { notify, bumpData, reloadBrokers } = useApp();
  const [busy, setBusy] = useState(false);
  /** Raportul ales, cât timp așteptăm răspunsul la întrebarea despre tranzacțiile manuale. */
  const [question, setQuestion] = useState<BrokerImportPreview | null>(null);
  const [result, setResult] = useState<BrokerImportResult | null>(null);
  /** Erorile unui CSV care nu a putut fi importat. */
  const [csvErrors, setCsvErrors] = useState<CsvImportResult | null>(null);

  const run = async (token: string, replaceManual: boolean): Promise<void> => {
    setBusy(true);
    try {
      const done = await api.brokerImport.apply(token, { replaceManual });
      setResult(done);
      await reloadBrokers();
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setQuestion(null);
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.brokerImport.open();
      if (res.canceled) return;
      if (res.csv) {
        // CSV în formatul aplicației: totul sau nimic.
        if (res.csv.errors.length > 0) {
          setCsvErrors(res.csv);
        } else {
          notify('success', `${count(res.csv.imported, 'tranzacție importată', 'tranzacții importate')}.`);
          await reloadBrokers();
          bumpData();
        }
        return;
      }
      if (!res.preview) return;
      if (res.preview.manualCount > 0) setQuestion(res.preview);
      else await run(res.preview.token, false);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant={variant}
        icon={<FileSpreadsheet className="size-4" />}
        loading={busy && !question}
        title="Fișierul Excel exportat din xStation (XTB) sau un CSV exportat din această aplicație"
        onClick={() => void start()}
      >
        Import Excel / CSV
      </Button>

      {question && (
        <Modal
          title="Ai deja tranzacții introduse manual"
          width="max-w-md"
          onClose={() => !busy && setQuestion(null)}
          footer={
            <>
              <Button disabled={busy} onClick={() => void run(question.token, false)}>
                Păstrează-le
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void run(question.token, true)}>
                Înlocuiește-le
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            La brokerul <strong className="text-ink">{question.brokerName}</strong> există {count(question.manualCount, 'tranzacție introdusă', 'tranzacții introduse')} manual pentru
            instrumentele din raport. Dacă le păstrezi și ele apar și în raport, vor fi numărate de două ori.
          </p>
          <p className="mt-2 text-sm text-ink-2">Le înlocuiesc cu cele din raportul XTB?</p>
        </Modal>
      )}

      {result && <ResultDialog result={result} onClose={() => setResult(null)} />}

      {csvErrors && (
        <Modal title="Importul nu a fost efectuat" onClose={() => setCsvErrors(null)} footer={<Button onClick={() => setCsvErrors(null)}>Închide</Button>}>
          <p className="mb-3 text-[13px] text-ink-2">Fișierul conține erori, așa că nu a fost salvată nicio tranzacție. Corectează rândurile de mai jos și încearcă din nou.</p>
          <ul className="max-h-72 space-y-1.5 overflow-y-auto text-[13px]">
            {csvErrors.errors.map((e, i) => (
              <li key={i} className="rounded-md bg-loss-soft px-3 py-1.5 text-ink">
                <strong>Rândul {e.line}:</strong> {e.message}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}

function ResultDialog({ result, onClose }: { result: BrokerImportResult; onClose: () => void }) {
  const showReported = result.positions.some((p) => p.reportedQuantity !== null);
  const mismatched = result.positions.filter((p) => p.reportedQuantity !== null && differs(p.quantity, p.reportedQuantity));
  const details = [
    result.buys > 0 && count(result.buys, 'cumpărare', 'cumpărări'),
    result.sells > 0 && count(result.sells, 'vânzare', 'vânzări'),
    result.dividends > 0 && count(result.dividends, 'dividend', 'dividende')
  ].filter(Boolean);

  return (
    <Modal title={result.imported > 0 ? 'Import finalizat' : 'Nimic nou de importat'} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Gata</Button>}>
      <div className="space-y-3 text-[13px] text-ink-2">
        <p className="text-sm text-ink">
          {result.imported > 0 ? (
            <>
              Am adăugat <strong>{count(result.imported, 'tranzacție', 'tranzacții')}</strong> la brokerul {result.brokerName}
              {details.length > 0 && <> ({details.join(', ')})</>}.
            </>
          ) : (
            <>Toate operațiunile din raport erau deja în aplicație.</>
          )}
          {result.imported > 0 && result.alreadyImported > 0 && <> Alte {result.alreadyImported} erau deja importate.</>}
          {result.createdAssets > 0 && <> {count(result.createdAssets, 'activ nou', 'active noi')} în portofoliu.</>}
          {result.replaced > 0 && <> {count(result.replaced, 'tranzacție manuală a fost înlocuită', 'tranzacții manuale au fost înlocuite')}.</>}
        </p>

        {result.positions.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-line">
                    <th className={TH}>Deții acum la {result.brokerName}</th>
                    <th className={cx(TH, 'text-right')}>Cantitate</th>
                    {showReported && <th className={cx(TH, 'text-right')}>În raport</th>}
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

        {result.incomplete.length > 0 && (
          <Notice tone="warn">
            <strong>Neimportate: {result.incomplete.join(', ')}.</strong> Raportul nu conține toate cumpărările lor. Exportă din xStation istoricul de la deschiderea contului și importă din nou —
            ce este deja importat nu se dublează.
          </Notice>
        )}
        {mismatched.length > 0 && (
          <Notice tone="warn">
            Cantitatea diferă de cea din raport pentru <strong>{mismatched.map((p) => p.symbol).join(', ')}</strong>. Cauze obișnuite: tranzacții introduse manual care apar și în raport, sau un split
            (acesta se adaugă din pagina Tranzacții).
          </Notice>
        )}
        {result.unconfirmed.length > 0 && (
          <Notice tone="warn">
            Fără preț automat pentru <strong>{result.unconfirmed.join(', ')}</strong>: simbolul nu a fost găsit la furnizorul de prețuri. Poziția este evaluată la cost până introduci un preț manual
            (Portofoliu → creion).
          </Notice>
        )}
        {result.offline && result.createdAssets > 0 && (
          <Notice tone="warn">Fără conexiune la internet: moneda și tipul activelor noi au fost deduse din simbol. Verifică-le în pagina Portofoliu.</Notice>
        )}
        {result.approximated > 0 && (
          <p>
            {count(result.approximated, 'dividend a fost convertit', 'dividende au fost convertite')} aproximativ din moneda contului în moneda activului (vezi nota tranzacției).
          </p>
        )}
        {result.ignored.length > 0 && (
          <p className="text-xs text-ink-3">
            Operațiuni din raport care nu se importă: {result.ignored.map((i) => `${i.label} (${i.count})`).join(', ')}.
          </p>
        )}
      </div>
    </Modal>
  );
}
