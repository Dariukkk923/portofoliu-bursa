/** Lista de brokeri a utilizatorului. */
import type { Broker, BrokerInput, BrokerResidence } from '@shared/types';
import { guessResidence } from '@shared/tax';
import type { Db } from '../db/database';
import { assert, rowToBroker } from './common';

function cleanName(name: unknown): string {
  const n = String(name ?? '').trim();
  assert(n.length >= 1 && n.length <= 60, 'Numele brokerului trebuie să aibă între 1 și 60 de caractere.');
  return n;
}

export function listBrokers(db: Db, userId: number): Broker[] {
  const rows = db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM transactions t WHERE t.broker_id = b.id AND t.user_id = b.user_id) AS transaction_count
       FROM brokers b WHERE b.user_id = ? ORDER BY b.name`
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToBroker);
}

export function getBroker(db: Db, userId: number, id: number): Broker | null {
  const r = db.prepare('SELECT * FROM brokers WHERE id = ? AND user_id = ?').get(id, userId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToBroker(r) : null;
}

export function findBrokerByName(db: Db, userId: number, name: string): Broker | null {
  const r = db.prepare('SELECT * FROM brokers WHERE user_id = ? AND name = ?').get(userId, name.trim()) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToBroker(r) : null;
}

const cleanResidence = (value: unknown, name: string): BrokerResidence =>
  value === 'ro' || value === 'foreign' ? value : guessResidence(name);

export function createBroker(db: Db, userId: number, input: BrokerInput): Broker {
  const name = cleanName(input.name);
  assert(!findBrokerByName(db, userId, name), 'Ai deja un broker cu acest nume.');
  const info = db
    .prepare('INSERT INTO brokers (user_id, name, notes, residence) VALUES (?, ?, ?, ?)')
    .run(userId, name, input.notes?.trim() || null, cleanResidence(input.residence, name));
  return getBroker(db, userId, Number(info.lastInsertRowid)) as Broker;
}

export function updateBroker(
  db: Db,
  userId: number,
  id: number,
  input: BrokerInput
): Broker {
  const current = getBroker(db, userId, id);
  assert(current, 'Brokerul nu a fost găsit.');
  const name = cleanName(input.name);
  const other = findBrokerByName(db, userId, name);
  assert(!other || other.id === id, 'Ai deja un broker cu acest nume.');
  const residence = input.residence === 'ro' || input.residence === 'foreign' ? input.residence : current.residence;
  db.prepare('UPDATE brokers SET name = ?, notes = ?, residence = ? WHERE id = ? AND user_id = ?').run(
    name,
    input.notes?.trim() || null,
    residence,
    id,
    userId
  );
  return getBroker(db, userId, id) as Broker;
}

/** Un broker poate fi șters doar dacă nu are tranzacții. */
export function deleteBroker(db: Db, userId: number, id: number): void {
  assert(getBroker(db, userId, id), 'Brokerul nu a fost găsit.');
  const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE broker_id = ? AND user_id = ?').get(id, userId) as {
    n: number;
  };
  assert(
    used.n === 0,
    `Brokerul are ${used.n} tranzacții înregistrate. Șterge sau mută tranzacțiile înainte de a șterge brokerul.`
  );
  db.prepare('DELETE FROM brokers WHERE id = ? AND user_id = ?').run(id, userId);
}
