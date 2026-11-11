/**
 * Conturi și autentificare.
 *
 * - Parolele se păstrează doar ca hash bcrypt (cost 12), niciodată în clar.
 * - „Ține-mă minte”: se generează un token aleator; în bază ajunge doar hash-ul
 *   lui SHA-256, iar tokenul propriu-zis este salvat criptat pe disc de stratul
 *   Electron (vezi main/session.ts).
 */
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { User } from '@shared/types';
import type { Db } from '../db/database';
import { AppError, assert, rowToUser } from './common';

const BCRYPT_ROUNDS = 12;
const SESSION_DAYS = 30;
const USERNAME_RE = /^[\p{L}\p{N}._-]{3,32}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;

export interface RegisterInput {
  username: string;
  email?: string | null;
  password: string;
}

function validatePassword(password: unknown): asserts password is string {
  assert(
    typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH,
    `Parola trebuie să aibă cel puțin ${MIN_PASSWORD_LENGTH} caractere.`
  );
  // bcrypt ia în calcul doar primii 72 de octeți; refuzăm parolele mai lungi ca să nu fie trunchiate pe ascuns.
  assert(Buffer.byteLength(password, 'utf8') <= 72, 'Parola este prea lungă (maximum 72 de octeți).');
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Creează un cont nou, cu setările implicite. */
export async function register(db: Db, input: RegisterInput, options: { isDemo?: boolean } = {}): Promise<User> {
  const username = String(input.username ?? '').trim();
  const email = input.email ? String(input.email).trim() : null;
  assert(
    USERNAME_RE.test(username),
    'Numele de utilizator trebuie să aibă 3–32 de caractere (litere, cifre, punct, cratimă sau underscore).'
  );
  assert(!email || EMAIL_RE.test(email), 'Adresa de email nu este validă.');
  validatePassword(input.password);

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  assert(!exists, 'Există deja un cont cu acest nume de utilizator.');

  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const create = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (username, email, password_hash, is_demo) VALUES (?, ?, ?, ?)')
      .run(username, email, hash, options.isDemo ? 1 : 0);
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(info.lastInsertRowid);
    // Fiecare cont pornește cu un portofoliu, „Principal”.
    db.prepare("INSERT INTO portfolios (user_id, name, base_currency) VALUES (?, 'Principal', 'RON')").run(info.lastInsertRowid);
    return Number(info.lastInsertRowid);
  });
  return getUser(db, create()) as User;
}

/** Verifică numele și parola; aruncă aceeași eroare în ambele cazuri de eșec. */
export async function verifyLogin(db: Db, username: string, password: string): Promise<User> {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim()) as
    | Record<string, unknown>
    | undefined;
  // Comparăm și când utilizatorul nu există, ca durata răspunsului să nu trădeze existența contului.
  const hash = (row?.password_hash as string) ?? '$2b$12$0000000000000000000000000000000000000000000000000000.';
  const ok = await bcrypt.compare(String(password ?? ''), hash).catch(() => false);
  if (!row || !ok) throw new AppError('Nume de utilizator sau parolă incorectă.');
  return rowToUser(row);
}

export function getUser(db: Db, userId: number): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function findUserByName(db: Db, username: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

/** Creează o sesiune persistentă și întoarce tokenul în clar (o singură dată). */
export function createRememberToken(db: Db, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`
  ).run(userId, sha256(token));
  return token;
}

/** Utilizatorul asociat unui token valid și neexpirat, sau null. */
export function userFromToken(db: Db, token: string): User | null {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
    )
    .get(sha256(token)) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function revokeToken(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function revokeAllTokens(db: Db, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Schimbă parola după verificarea celei vechi și invalidează sesiunile salvate. */
export async function changePassword(db: Db, userId: number, oldPassword: string, newPassword: string): Promise<void> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  assert(row, 'Contul nu a fost găsit.');
  const ok = await bcrypt.compare(String(oldPassword ?? ''), row.password_hash);
  assert(ok, 'Parola actuală este incorectă.');
  validatePassword(newPassword);
  assert(newPassword !== oldPassword, 'Parola nouă trebuie să fie diferită de cea actuală.');
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    revokeAllTokens(db, userId);
  })();
}
