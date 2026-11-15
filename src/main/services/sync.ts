/**
 * Sincronizarea contului între dispozitive (calculator și telefon), criptată cap-coadă.
 *
 * Pe server stă un singur pachet per cont: baza SQLite a contului (fără cache-uri), comprimată și criptată
 * cu o cheie derivată din parolă. Fiecare dispozitiv ține minte versiunea de pe server și amprenta datelor
 * locale de la ultima sincronizare (tabela sync_state):
 *  - datele locale s-au schimbat → se trimit (PUT cu versiunea de bază; 409 = s-au schimbat și pe server);
 *  - doar serverul are o versiune nouă → se descarcă și se restaurează local;
 *  - s-au schimbat ambele → conflict: utilizatorul alege ce păstrăm.
 * Rulează automat: la deschiderea sesiunii, la fiecare minut și la câteva secunde după o modificare.
 * Nu rulează niciodată două sincronizări deodată. Contul demo nu se sincronizează.
 */
import type { Db } from '../db/database';
import type { SecretBox } from '../secrets';
import type { User } from '@shared/types';
import { SYNC_USERNAME_RE, type SyncChoice, type SyncState, type SyncStatus } from '@shared/sync';
import { AppError } from './common';
import { conflictOf, createSyncApi, lockedFor, SyncHttpError, SyncOfflineError, type SyncApi, type SyncHead, type SyncSnapshot } from './syncApi';
import { decryptSnapshot, deriveSyncKeys, encryptSnapshot, keysFromText, keysToText, type SyncKeys } from './syncCrypto';
import { dataHash, hasNoUserData, readSyncRow, writeSyncRow } from './syncData';

export interface SyncConfig {
  /** Adresa serverului (fără „/sync”). */
  url: string;
  /** Numele acestui dispozitiv, ex. „Windows · calculator”, „iPhone”. */
  device: string;
  fetch?: typeof fetch;
  /** Verificarea periodică (implicit 60 s). */
  intervalMs?: number;
  /** Întârzierea după o modificare (implicit 4 s). */
  debounceMs?: number;
}

export interface SyncHost {
  db: Db;
  secrets: SecretBox;
  /** Pachetul contului (baza SQLite, fără cache-uri) și restaurarea lui. */
  createSnapshot(userId: number): Uint8Array;
  restoreSnapshot(userId: number, data: Uint8Array): void;
  /** Web: pregătește criptarea (asincronă) a unui secret înainte de `secrets.encrypt`. */
  sealSecret?(plain: string): Promise<void>;
  /** Starea s-a schimbat (doar pentru utilizatorul sesiunii). */
  onStatus(status: SyncStatus): void;
  /** Datele contului au fost înlocuite cu cele de pe server. */
  onRestored(userId: number): void;
}

type Mode = 'local' | 'full' | 'manual';
const RANK: Record<Mode, number> = { local: 0, full: 1, manual: 2 };

/** Stări salvate care opresc reîncercările automate (fiecare încercare ar număra ca autentificare greșită pe server). */
const BLOCKED = new Set(['name_taken', 'password_changed']);

const MSG = {
  wrongLogin: 'Nume de utilizator sau parolă incorectă.',
  offlineLogin: 'Nume de utilizator sau parolă incorectă. (nu s-a putut verifica online)',
  taken: 'Numele este folosit deja. Dacă e contul tău de pe alt dispozitiv, folosește Autentificare.',
  unreadable: 'Datele de pe server nu au putut fi citite.',
  passwordChanged: 'Parola a fost schimbată pe celălalt dispozitiv. Ieși din cont și intră din nou cu parola nouă.',
  noKeys: 'Ieși din cont și intră din nou cu parola, ca să pornească sincronizarea.',
  badName: 'Numele contului are diacritice sau alte caractere speciale, așa că nu se poate sincroniza.',
  tooLarge: 'Datele sunt prea mari pentru sincronizare.',
  generic: 'Sincronizarea nu a reușit. Se reîncearcă automat.',
  passwordOffline: 'Pentru schimbarea parolei e nevoie de internet (parola se schimbă și pe celălalt dispozitiv). Încearcă din nou.',
  passwordConflict: 'Datele s-au schimbat și pe celălalt dispozitiv. Alege întâi ce date păstrăm, apoi schimbă parola.'
};

const isStatus = (err: unknown, status: number): boolean => err instanceof SyncHttpError && err.status === status;

/** „Prea multe încercări, încearcă peste N minute.” */
const lockedMessage = (secs: number): string => {
  const min = Math.max(1, Math.ceil(secs / 60));
  return `Prea multe încercări, încearcă peste ${min === 1 ? 'un minut' : `${min} minute`}.`;
};

export class SyncEngine {
  private readonly api: SyncApi;
  private user: { id: number; keys: SyncKeys } | null = null;
  /** Starea „din mers” (nesalvată): în curs, fără internet, eroare. null = cea salvată. */
  private live: { state: SyncState; message: string | null } | null = null;
  private off: string | null = null;
  /** Serverul a blocat contul (prea multe încercări greșite): până atunci nu mai trimitem nimic. */
  private locked: { userId: number; until: number } | null = null;
  private checkedAt: number | null = null;
  private lastEmitted = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private pending: { mode: Mode; promise: Promise<void> } | null = null;
  /** Pornirea după autentificare (derivarea cheilor durează); `gen` anulează pornirile depășite. */
  private starting: Promise<void> | null = null;
  private gen = 0;

  constructor(
    private readonly host: SyncHost,
    private readonly config: SyncConfig
  ) {
    this.api = createSyncApi(config.url, config.fetch ?? ((input, init) => fetch(input, init)));
  }

  /** Numele se poate folosi online (litere fără diacritice, cifre, . _ -). */
  static canSync(username: string): boolean {
    return SYNC_USERNAME_RE.test(String(username ?? '').trim());
  }

  derive(username: string, password: string): Promise<SyncKeys> {
    return deriveSyncKeys(username, password);
  }

  // --- autentificare -------------------------------------------------------

  /** Login pe un dispozitiv fără contul local: verifică parola online și aduce datele (null = contul online e gol). */
  async fetchForLogin(keys: SyncKeys): Promise<{ snapshot: SyncSnapshot; data: Uint8Array } | null> {
    let snapshot: SyncSnapshot | null;
    try {
      snapshot = await this.api.snapshot(keys);
    } catch (err) {
      if (err instanceof SyncOfflineError) throw new AppError(MSG.offlineLogin);
      if (isStatus(err, 401)) throw new AppError(MSG.wrongLogin);
      const secs = lockedFor(err);
      if (secs !== null) throw new AppError(lockedMessage(secs));
      throw new AppError('Contul nu a putut fi verificat online. Încearcă din nou.');
    }
    if (!snapshot) return null;
    try {
      return { snapshot, data: await decryptSnapshot(keys.encKey, snapshot.data) };
    } catch {
      throw new AppError(MSG.unreadable);
    }
  }

  /** Contul nou se creează și online. 'offline' = se va înregistra mai târziu, automat. */
  async registerOnline(keys: SyncKeys): Promise<'ok' | 'offline' | 'invalid'> {
    try {
      await this.api.register(keys);
      return 'ok';
    } catch (err) {
      // Fără internet sau server indisponibil temporar: contul online se creează mai târziu, automat.
      if (err instanceof SyncOfflineError || (err instanceof SyncHttpError && err.status >= 500)) return 'offline';
      if (isStatus(err, 409)) throw new AppError(MSG.taken);
      return 'invalid';
    }
  }

  /** Parola este cea a contului online? (false și când serverul nu răspunde) */
  async checkOnline(keys: SyncKeys): Promise<boolean> {
    try {
      await this.api.head(keys);
      return true;
    } catch {
      return false;
    }
  }

  /** Cheile se păstrează criptate pe dispozitiv (pentru „ține-mă minte”). */
  async storeKeys(userId: number, keys: SyncKeys, linked?: boolean): Promise<void> {
    const text = keysToText(keys);
    let stored: string | null = null;
    try {
      await this.host.sealSecret?.(text);
      stored = this.host.secrets.encrypt(text);
    } catch {
      stored = null; // fără cheie de criptare: sincronizarea merge doar până la ieșirea din cont
    }
    const prev = readSyncRow(this.host.db, userId);
    const same = keysFromText(prev.creds ? this.host.secrets.decrypt(prev.creds) : null)?.authKey === keys.authKey;
    writeSyncRow(this.host.db, userId, { creds: stored, linked: linked ?? (same && prev.linked) });
    if (this.user?.id === userId) this.user.keys = keys;
  }

  isLinked(userId: number): boolean {
    return readSyncRow(this.host.db, userId).linked;
  }

  /** Contul tocmai creat pe acest dispozitiv primește datele de pe server. */
  async adopt(userId: number, keys: SyncKeys, remote: { snapshot: SyncSnapshot; data: Uint8Array } | null): Promise<void> {
    await this.storeKeys(userId, keys, true);
    if (!remote) return;
    this.host.restoreSnapshot(userId, remote.data);
    writeSyncRow(this.host.db, userId, {
      version: remote.snapshot.version,
      hash: dataHash(this.host.db, userId),
      syncedAt: Date.now(),
      status: 'ok',
      remoteDevice: remote.snapshot.device
    });
  }

  /**
   * Schimbarea parolei: pachetul se recriptează cu cheia nouă și serverul primește noua cheie de autentificare.
   * Se apelează înainte de schimbarea locală; aruncă eroare dacă nu se poate (fără internet, conflict).
   * Întoarce cheile noi, de salvat după ce s-au recriptat secretele locale.
   */
  async changePassword(user: User, newPassword: string): Promise<{ keys: SyncKeys; linked: boolean } | null> {
    if (this.user?.id !== user.id) return null;
    const keys = await deriveSyncKeys(user.username, newPassword);
    const row = readSyncRow(this.host.db, user.id);
    if (!row.linked) {
      this.user.keys = keys;
      return { keys, linked: false };
    }
    await this.enqueue('full');
    return this.exclusive(async () => {
      const u = this.user;
      if (!u || u.id !== user.id) return null;
      const st = readSyncRow(this.host.db, user.id);
      if (st.status === 'conflict') throw new AppError(MSG.passwordConflict);
      if (!st.linked) {
        u.keys = keys;
        return { keys, linked: false };
      }
      const hash = dataHash(this.host.db, u.id);
      const blob = await encryptSnapshot(keys.encKey, this.host.createSnapshot(u.id));
      try {
        const res = await this.api.password(u.keys, keys.authKey, st.version, this.config.device, blob);
        writeSyncRow(this.host.db, u.id, { version: res.version, hash, syncedAt: Date.now(), status: 'ok', remoteDevice: this.config.device });
      } catch (err) {
        if (err instanceof SyncOfflineError || (err instanceof SyncHttpError && err.status >= 500)) throw new AppError(MSG.passwordOffline);
        const secs = lockedFor(err);
        if (secs !== null) throw new AppError(lockedMessage(secs));
        if (conflictOf(err)) {
          void this.enqueue('full');
          throw new AppError('Datele tocmai s-au schimbat pe celălalt dispozitiv. Încearcă din nou peste câteva secunde.');
        }
        if (isStatus(err, 401)) {
          // Parola contului online nu mai este cea de aici (schimbată pe alt dispozitiv): se reface legătura la următoarea sincronizare.
          u.keys = keys;
          return { keys, linked: false };
        }
        throw err;
      }
      u.keys = keys;
      return { keys, linked: true };
    });
  }

  // --- sesiunea ------------------------------------------------------------

  /**
   * Pornește sincronizarea pentru utilizatorul sesiunii. `keys` vin de la autentificarea cu parolă;
   * fără ele (sesiune reluată) se folosesc cele salvate. `fresh` = autentificare nouă: se reîncearcă și stările blocate.
   */
  start(user: User, keys: SyncKeys | null = null, fresh = false): void {
    this.stop();
    if (user.isDemo) return this.emit();
    if (!SyncEngine.canSync(user.username)) {
      this.off = MSG.badName;
      return this.emit();
    }
    const row = readSyncRow(this.host.db, user.id);
    const k = keys ?? keysFromText(row.creds ? this.host.secrets.decrypt(row.creds) : null);
    if (!k) {
      this.off = MSG.noKeys;
      return this.emit();
    }
    if (fresh && BLOCKED.has(row.status)) writeSyncRow(this.host.db, user.id, { status: 'off' });
    this.user = { id: user.id, keys: k };
    void this.enqueue('full');
    this.timer = setInterval(() => void this.enqueue('full'), this.config.intervalMs ?? 60_000);
  }

  /** Autentificare cu parolă pe un cont existent: cheile se derivă în fundal, apoi pornește sincronizarea. */
  async startWithPassword(user: User, password: string, keys: SyncKeys | null = null): Promise<void> {
    if (user.isDemo || !SyncEngine.canSync(user.username)) return this.start(user);
    const gen = ++this.gen;
    const run = (async () => {
      const k = keys ?? (await deriveSyncKeys(user.username, password));
      if (gen !== this.gen) return; // între timp: ieșire din cont sau altă autentificare
      await this.storeKeys(user.id, k);
      if (gen !== this.gen) return;
      this.start(user, k, true);
    })();
    this.starting = run;
    try {
      await run;
    } finally {
      if (this.starting === run) this.starting = null;
    }
  }

  stop(): void {
    this.gen++;
    this.starting = null;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.user = null;
    this.live = null;
    this.off = null;
    this.checkedAt = null;
  }

  /** Ceva s-a putut modifica: peste câteva secunde se compară amprenta (fără rețea dacă nu s-a schimbat nimic). */
  touched(): void {
    if (!this.user) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.enqueue('local');
    }, this.config.debounceMs ?? 4_000);
  }

  async now(): Promise<SyncStatus> {
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.user) await this.enqueue('manual');
    return this.status();
  }

  async resolve(choice: SyncChoice): Promise<SyncStatus> {
    await this.exclusive(async () => {
      const u = this.user;
      if (!u || readSyncRow(this.host.db, u.id).status !== 'conflict') return;
      this.setLive('syncing');
      try {
        if (choice === 'remote') await this.pull(u, null);
        else await this.push(u, (await this.api.head(u.keys)).version, true);
        if (this.user === u && this.live?.state === 'syncing') this.live = null;
      } catch (err) {
        this.fail(u, err);
      }
    });
    this.emit();
    return this.status();
  }

  status(): SyncStatus {
    const u = this.user;
    if (!u) return { state: 'off', lastSyncAt: null, device: null, message: this.off };
    const row = readSyncRow(this.host.db, u.id);
    const lastSyncAt = Math.max(row.syncedAt ?? 0, this.checkedAt ?? 0) || null;
    const base = { lastSyncAt, device: row.remoteDevice };
    if (row.status === 'conflict') return { ...base, state: 'conflict', message: null };
    if (row.status === 'name_taken') return { ...base, state: 'name_taken', message: null };
    if (row.status === 'password_changed') return { ...base, state: 'error', message: MSG.passwordChanged };
    if (this.live) return { ...base, state: this.live.state, message: this.live.message };
    return { ...base, state: row.status === 'ok' ? 'ok' : 'syncing', message: null };
  }

  // --- rularea -------------------------------------------------------------

  /** Pune o sincronizare la rând (una singură așteaptă; cea mai „puternică” cerere câștigă). */
  private enqueue(mode: Mode): Promise<void> {
    if (this.pending) {
      if (RANK[mode] > RANK[this.pending.mode]) this.pending.mode = mode;
      return this.pending.promise;
    }
    const entry = { mode, promise: Promise.resolve() };
    entry.promise = this.chain.then(async () => {
      if (this.pending === entry) this.pending = null;
      await this.runOnce(entry.mode);
    });
    entry.promise = entry.promise.catch((err) => console.error('[sync]', err));
    this.pending = entry;
    this.chain = entry.promise;
    return entry.promise;
  }

  /** O operațiune care nu are voie să ruleze în paralel cu sincronizarea. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  private async runOnce(mode: Mode): Promise<void> {
    const u = this.user;
    if (!u) return;
    const db = this.host.db;
    const row = readSyncRow(db, u.id);
    if (row.status === 'conflict') return this.emit(); // așteaptă alegerea utilizatorului
    if (BLOCKED.has(row.status) && mode !== 'manual') return this.emit();
    if (this.locked?.userId === u.id) {
      const left = this.locked.until - Date.now();
      if (left > 0) return this.setLive('error', lockedMessage(left / 1000));
      this.locked = null;
    }
    const hash = dataHash(db, u.id);
    const changed = row.hash === null || hash !== row.hash;
    if (mode === 'local' && !changed) return;

    this.setLive('syncing');
    try {
      const head = await this.headOrLink(u, row.linked);
      if (!head || this.user !== u) return;
      this.checkedAt = Date.now();
      if (head.device !== row.remoteDevice && head.version > 0) writeSyncRow(db, u.id, { remoteDevice: head.device });
      if (head.version === 0) {
        await this.push(u, 0, false);
      } else if (head.version === row.version) {
        if (changed) await this.push(u, row.version, false);
        else if (row.status !== 'ok') writeSyncRow(db, u.id, { status: 'ok' });
      } else {
        // Serverul are altă versiune decât cea sincronizată ultima oară.
        const firstTime = row.version === 0 && row.hash === null;
        if (firstTime ? hasNoUserData(db, u.id) : !changed) await this.pull(u, hash);
        else this.setConflict(u, head);
      }
      if (this.user === u && this.live?.state === 'syncing') this.live = null;
    } catch (err) {
      this.fail(u, err);
    } finally {
      if (this.user === u) this.emit();
    }
  }

  /** Versiunea de pe server; contul online se creează dacă nu există. null = numele e luat online. */
  private async headOrLink(u: { id: number; keys: SyncKeys }, linked: boolean): Promise<SyncHead | null> {
    try {
      const head = await this.api.head(u.keys);
      if (!linked) writeSyncRow(this.host.db, u.id, { linked: true, status: 'ok' });
      return head;
    } catch (err) {
      if (!isStatus(err, 401)) throw err;
      if (linked) {
        writeSyncRow(this.host.db, u.id, { status: 'password_changed' });
        this.live = null;
        return null;
      }
    }
    try {
      await this.api.register(u.keys);
    } catch (err) {
      if (!isStatus(err, 409)) throw err;
      writeSyncRow(this.host.db, u.id, { status: 'name_taken' });
      this.live = null;
      return null;
    }
    // Cont online nou: tot ce e local se trimite de la zero.
    writeSyncRow(this.host.db, u.id, { linked: true, version: 0, status: 'ok' });
    return { version: 0, updatedAt: null, device: null };
  }

  /** Trimite datele locale. `force` = alegerea utilizatorului la conflict (un nou 409 rămâne conflict). */
  private async push(u: { id: number; keys: SyncKeys }, baseVersion: number, force: boolean): Promise<void> {
    const db = this.host.db;
    // Amprenta și pachetul se citesc în același pas sincron, deci descriu exact aceleași date.
    const hash = dataHash(db, u.id);
    const blob = await encryptSnapshot(u.keys.encKey, this.host.createSnapshot(u.id));
    if (this.user !== u) return;
    let res: { version: number; updatedAt: number };
    try {
      res = await this.api.put(u.keys, baseVersion, this.config.device, blob);
    } catch (err) {
      const conflict = conflictOf(err);
      if (!conflict || this.user !== u) throw err;
      const row = readSyncRow(db, u.id);
      // Altcineva a trimis între timp; dacă aici nu s-a schimbat nimic de la ultima sincronizare, doar descărcăm.
      if (!force && row.hash !== null && row.hash === dataHash(db, u.id)) return this.pull(u, row.hash);
      return this.setConflict(u, conflict);
    }
    writeSyncRow(db, u.id, { version: res.version, hash, syncedAt: Date.now(), status: 'ok', remoteDevice: this.config.device });
    this.checkedAt = Date.now();
  }

  /**
   * Descarcă și restaurează datele de pe server. `expected` = amprenta locală înainte de descărcare:
   * dacă între timp utilizatorul a modificat ceva, nu restaurăm peste (următoarea rulare decide).
   */
  private async pull(u: { id: number; keys: SyncKeys }, expected: string | null): Promise<void> {
    const db = this.host.db;
    const snap = await this.api.snapshot(u.keys);
    if (this.user !== u) return;
    if (!snap) return this.push(u, 0, false);
    let data: Uint8Array;
    try {
      data = await decryptSnapshot(u.keys.encKey, snap.data);
    } catch {
      throw new AppError(MSG.unreadable);
    }
    if (this.user !== u) return;
    if (expected !== null && dataHash(db, u.id) !== expected) {
      void this.enqueue('full');
      return;
    }
    this.host.restoreSnapshot(u.id, data);
    writeSyncRow(db, u.id, { version: snap.version, hash: dataHash(db, u.id), syncedAt: Date.now(), status: 'ok', remoteDevice: snap.device });
    this.checkedAt = Date.now();
    this.host.onRestored(u.id);
  }

  private setConflict(u: { id: number }, remote: SyncHead): void {
    writeSyncRow(this.host.db, u.id, { status: 'conflict', remoteDevice: remote.device });
    this.live = null;
  }

  private setLive(state: SyncState, message: string | null = null): void {
    this.live = { state, message };
    this.emit();
  }

  private fail(u: { id: number }, err: unknown): void {
    if (this.user !== u) return;
    if (err instanceof SyncOfflineError) return this.setLive('offline');
    const secs = lockedFor(err);
    if (secs !== null) {
      this.locked = { userId: u.id, until: Date.now() + secs * 1000 };
      return this.setLive('error', lockedMessage(secs));
    }
    if (isStatus(err, 413)) return this.setLive('error', MSG.tooLarge);
    if (err instanceof SyncHttpError && err.status >= 500) return this.setLive('error', 'Serverul de sincronizare nu răspunde acum. Se reîncearcă automat.');
    if (err instanceof AppError) return this.setLive('error', err.message);
    console.error('[sync] sincronizarea a eșuat:', err);
    this.setLive('error', MSG.generic);
  }

  private emit(): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.host.onStatus(status);
  }
}
