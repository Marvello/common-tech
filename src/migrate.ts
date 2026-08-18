import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function runMigrations(pool: pg.Pool, dir: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const applied = new Set(
    (await pool.query('SELECT version FROM schema_migrations ORDER BY version'))
      .rows.map((r: { version: string }) => r.version),
  )

  const files = (await readdir(dir))
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const version = file.replace(/\.sql$/, '').split('_')[0]
    if (applied.has(version)) continue

    const sql = await readFile(join(dir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [version, file.replace(/\.sql$/, '')],
      )
      await client.query('COMMIT')
      console.log(`Applied: ${file}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}
