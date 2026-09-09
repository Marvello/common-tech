# common-tech

Shared engineering conventions across Marvello projects. **Docs, not code** —
there's no package to install. Each repo owns its own small copy of a pattern;
this repo is the single source of the convention so the copies stay in sync
without publishing/versioning a dependency.

---

## Postgres client pattern

Convention shared by **Vitalix/web** (`src/db.js`), **folionix/web** (`lib/db.ts`),
and **folionix/app** (`src/db/db.ts`).

Kept as a documented pattern, not a shared package: the code is ~30 lines, each
repo owns its own copy, and there's nothing to publish, version, or update in
two places. Copy the pattern, don't depend on it.

### The pattern

One module owns the `pg.Pool`. Everything else imports `query` / `withTransaction`
from it — no other file constructs a pool or calls `pool.connect()` directly.

```js
import pg from "pg";

// Return date/timestamp columns as ISO strings, not JS Date objects, so callers
// can .slice()/compare/serialize without timezone surprises. Set this ONCE,
// before the first query — pg type parsers are global.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1114, (v) => v); // timestamp
pg.types.setTypeParser(1184, (v) => v); // timestamptz

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // tune per service; folionix uses 5
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err; // always rethrow after ROLLBACK — never swallow
  } finally {
    client.release(); // finally, so the client returns to the pool even on throw
  }
}

export async function ping() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
```

### Rules

- **Single pool per process.** One long-lived `pg.Pool`, never a pool or bare
  `Client` per request. In frameworks that hot-reload (Next.js), use a lazy
  singleton so dev reloads don't leak pools:

  ```ts
  let _pool: pg.Pool | null = null;
  export function getPool(): pg.Pool {
    if (!_pool) {
      const url = process.env["DATABASE_URL"];
      if (!url) throw new Error("DATABASE_URL required");
      _pool = new pg.Pool({ connectionString: url, max: 5 });
    }
    return _pool;
  }
  ```

- **All multi-statement writes go through `withTransaction`.** BEGIN/COMMIT with
  ROLLBACK-on-throw in `finally`, so a failure never leaves a half-applied write
  or a leaked client.
- **Parameterize** — always `query(text, params)`, never string interpolation.
- **Set the ISO type parsers once, at module load,** before any query. They're
  process-global; setting them mid-run gives inconsistent row shapes.
- **`ping()`** backs the health check / readiness probe.

### Migrations — one style

Every repo uses the **same migration style**: plain `.sql` files applied by a
small in-process runner, tracked in a `schema_migrations` ledger. No ORM
migration tool, no per-repo divergence.

**Files.** `db/migrations/NNN_name.sql`, three-digit zero-padded, applied in
numeric order. Each file is one forward migration in plain SQL. No `down()` — a
mistake is fixed by a new forward migration, not a reversal.

```
db/migrations/
  001_init.sql
  002_auth.sql
  003_add_widgets.sql
```

**Ledger.** `schema_migrations (version text primary key, name text, applied_at
timestamptz)`. The runner records one row per applied file; a version already in
the ledger is skipped.

**Runner.** A ~90-line module (`src/migrate.js` / `src/db/migrate.ts`) that:
- takes a `pg_advisory_lock` so concurrent boots (bot + worker + web) serialize
  rather than race,
- creates `schema_migrations` if absent,
- applies each pending file in its own transaction, then inserts its ledger row,
- exposes `runPendingMigrations()` and a `--check` CLI (report pending, exit 1 if any).

**Auto-run on start.** The main process applies pending migrations *before* it
serves — the schema must match the code that starts. A migration failure aborts
startup rather than serving against a stale schema. Don't run migrations from a
container `CMD &&` chain or a separate deploy step; the app owns it.

```js
async function start() {
  await runPendingMigrations();   // idempotent: no-op when up to date
  app.listen(port);
}
```

**Adopting an existing database.** When a live DB predates this runner (e.g. it
used a different migration tool, or has tables but no `schema_migrations`), the
runner backfills the ledger from the old state *once* — recording already-applied
migrations as done so they are never replayed — before running anything new. This
is a transitional shim per repo (e.g. Vitalix adopts its old `node-pg-migrate`
`pgmigrations` ledger on first boot); delete it once every live DB has cut over.

---

## Password hashing — one library

Use **`bcryptjs`** (pure JS) everywhere — not the native `bcrypt`:
- No native build (`node-gyp`), so it works on alpine/musl, cross-arch, and in
  Next.js / serverless where native modules are painful.
- Emits standard `$2b$` hashes, **interchangeable with native `bcrypt`** — a
  password row is portable between repos, and switching from `bcrypt` to
  `bcryptjs` does not invalidate existing hashes.
- Slower than native, negligible at login volume.

Contract: hash on write, `compare` on verify, cost from `BCRYPT_ROUNDS` (default
12), against `users.password_hash`.

```js
import bcrypt from "bcryptjs";
const hash   = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS ?? 12));
const ok     = await bcrypt.compare(password, user.password_hash);
```

## Auth direction

Vitalix runs its own auth on Express today (JWT access + refresh-token rotation,
password reset, invites). folionix uses **NextAuth (Auth.js) Credentials + JWT
session** on Next.js. The convergence target is NextAuth for both — but that
lands with Vitalix's Express→Next.js migration, not before: NextAuth's leverage
(route handlers, session cookie, CSRF) only exists once an app is on Next.js.
Until then the shared contract is just this: the same `users` table shape and
`bcryptjs` hashes, so accounts are portable across both.
