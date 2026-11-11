/**
 * Ecranul „Portofolii”: gestionarea portofoliilor (creare, redenumire, culoare,
 * iconiță, monedă de bază, indice de referință, duplicare, arhivare, ștergere)
 * și comparația lor, unul lângă altul: valoare, profit, randament și risc.
 */
import { useState } from 'react';
import { Archive, ArchiveRestore, Copy, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Portfolio } from '@shared/types';
import { benchmarkName } from '@shared/benchmarks';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { money, percent, signedMoney, signedPercent } from '../lib/format';
import { PortfolioForm, PortfolioIcon } from '../components/portfolio';
import { Badge, Button, Card, ConfirmDialog, IconButton, ListSkeleton, LoadError, Pnl, TD, TH, cx } from '../components/ui';

export function PortfoliosPage({ onOpen }: { onOpen: () => void }) {
  const { portfolios, activePortfolios, settings, setScope, reloadPortfolios, bumpData, notify, dataVersion } = useApp();
  const comparison = useLoad(() => api.portfolios.compare(), [dataVersion, portfolios]);
  const [editing, setEditing] = useState<Portfolio | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Portfolio | null>(null);
  const [busy, setBusy] = useState(false);
  const base = settings?.baseCurrency ?? 'RON';

  const run = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true);
    try {
      await action();
      await reloadPortfolios();
      bumpData();
      notify('success', success);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const archived = portfolios.filter((p) => p.archived);

  return (
    <>
      <Card
        title="Portofoliile tale"
        action={
          <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Portofoliu nou
          </Button>
        }
      >
        <p className="-mt-1 mb-3 text-body text-ink-2">
          Fiecare portofoliu are tranzacțiile, cash-ul și randamentul lui. Schimbi portofoliul afișat din bara de sus; „Toate portofoliile” le adună, în {base}.
        </p>
        <ul className="divide-y divide-line">
          {[...activePortfolios, ...archived].map((p) => (
            <li key={p.id} className={cx('flex flex-wrap items-center gap-3 py-3', p.archived && 'opacity-70')}>
              <PortfolioIcon color={p.color} icon={p.icon} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="truncate">{p.name}</span>
                  {p.archived && <Badge>Arhivat</Badge>}
                </p>
                <p className="text-xs text-ink-3">
                  {p.baseCurrency} · {p.transactionCount ?? 0} tranzacții · comparat cu {benchmarkName(p.benchmark)}
                </p>
              </div>
              <div className="flex items-center gap-1 max-md:basis-full max-md:justify-end">
                {!p.archived && (
                  <IconButton
                    label={`Deschide „${p.name}”`}
                    onClick={() => {
                      setScope(p.id);
                      onOpen();
                    }}
                  >
                    <Eye className="size-4" />
                  </IconButton>
                )}
                <IconButton label={`Editează „${p.name}”`} onClick={() => setEditing(p)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton label={`Duplică „${p.name}”`} disabled={busy} onClick={() => void run(() => api.portfolios.duplicate(p.id), `Am creat o copie a portofoliului „${p.name}”.`)}>
                  <Copy className="size-4" />
                </IconButton>
                <IconButton
                  label={p.archived ? `Dezarhivează „${p.name}”` : `Arhivează „${p.name}”`}
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.portfolios.archive(p.id, !p.archived), p.archived ? `„${p.name}” este din nou activ.` : `„${p.name}” a fost arhivat. Datele lui rămân păstrate.`)
                  }
                >
                  {p.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                </IconButton>
                <IconButton label={`Șterge „${p.name}”`} disabled={busy} onClick={() => setDeleting(p)}>
                  <Trash2 className="size-4 text-loss" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Comparație între portofolii" padded={false}>
        {comparison.loading && !comparison.data ? (
          <ListSkeleton rows={3} />
        ) : comparison.error ? (
          <div className="p-4">
            <LoadError message={comparison.error} onRetry={comparison.reload} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH}>Portofoliu</th>
                  <th className={cx(TH, 'text-right')}>Valoare ({base})</th>
                  <th className={cx(TH, 'text-right')}>Din care cash</th>
                  <th className={cx(TH, 'text-right')}>Profit total</th>
                  <th className={cx(TH, 'text-right')} title="Randament ponderat în timp, de la prima tranzacție">
                    Randament (TWR)
                  </th>
                  <th className={cx(TH, 'text-right')} title="Cât de mult variază valoarea de la o zi la alta, pe an">
                    Volatilitate
                  </th>
                  <th className={cx(TH, 'text-right')} title="Cea mai mare scădere de la un vârf">
                    Scădere maximă
                  </th>
                  <th className={cx(TH, 'text-right')}>Poziții</th>
                </tr>
              </thead>
              <tbody>
                {(comparison.data ?? []).map((c) => (
                  <tr key={c.portfolioId} className="border-b border-line last:border-0">
                    <td className={TD}>
                      <span className="inline-flex items-center gap-2 font-semibold">
                        <PortfolioIcon color={c.color} icon={c.icon} size="sm" />
                        {c.name}
                      </span>
                    </td>
                    <td className={cx(TD, 'tabular text-right font-medium')}>{money(c.value, base)}</td>
                    <td className={cx(TD, 'tabular text-right text-ink-2')}>{money(c.cash, base)}</td>
                    <td className={cx(TD, 'tabular text-right')}>
                      <Pnl value={c.totalPnl} arrow>
                        {signedMoney(c.totalPnl, base)}
                      </Pnl>
                    </td>
                    <td className={cx(TD, 'tabular text-right')}>
                      {c.twr === null ? (
                        <span className="text-ink-3">—</span>
                      ) : (
                        <>
                          <Pnl value={c.twr}>{signedPercent(c.twr)}</Pnl>
                          {c.twrAnnualized !== null && <span className="block text-xs text-ink-3">{signedPercent(c.twrAnnualized)} pe an</span>}
                        </>
                      )}
                    </td>
                    <td className={cx(TD, 'tabular text-right')}>{c.volatility === null ? <span className="text-ink-3">—</span> : percent(c.volatility)}</td>
                    <td className={cx(TD, 'tabular text-right')}>
                      {c.maxDrawdown === null ? <span className="text-ink-3">—</span> : <span className="text-loss">{signedPercent(c.maxDrawdown)}</span>}
                    </td>
                    <td className={cx(TD, 'tabular text-right')}>{c.positions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-3">
          Toate sumele sunt în {base}, la cursurile de azi (costul, la cursul din ziua fiecărei tranzacții). Volatilitatea și scăderea maximă se calculează din evoluția
          randamentului; au nevoie de prețuri istorice (se descarcă la actualizarea prețurilor).
        </p>
      </Card>

      {editing && (
        <PortfolioForm
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            void reloadPortfolios().then(bumpData);
            notify('success', editing === 'new' ? `Portofoliul „${p.name}” a fost creat.` : 'Modificările au fost salvate.');
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Ștergi portofoliul „${deleting.name}”?`}
          busy={busy}
          message={
            <>
              Se șterg definitiv portofoliul și{' '}
              <strong className="text-ink">{deleting.transactionCount === 1 ? 'o tranzacție' : `${deleting.transactionCount ?? 0} tranzacții`}</strong> din el. Nu se poate
              anula. Dacă vrei doar să nu-l mai vezi, arhivează-l.
            </>
          }
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            void run(() => api.portfolios.remove(deleting.id), `Portofoliul „${deleting.name}” a fost șters.`).finally(() => setDeleting(null))
          }
        />
      )}
    </>
  );
}
