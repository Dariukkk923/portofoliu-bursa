/** În browser baza este sql.js (vezi ../sqljs.ts); better-sqlite3 există doar ca să se poată rezolva importurile. */
export default class Database {
  constructor() {
    throw new Error('better-sqlite3 nu există în versiunea web.');
  }
}
