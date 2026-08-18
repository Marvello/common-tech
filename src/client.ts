import pg from 'pg'

export interface PoolConfig {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean | object
  max?: number
}

export function createPool(config: PoolConfig): pg.Pool {
  return new pg.Pool({
    ...config,
    max: config.max ?? 10,
  })
}

export async function query(
  pool: pg.Pool,
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult> {
  return pool.query(text, params)
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
