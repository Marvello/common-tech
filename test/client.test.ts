import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createPool, query, withTransaction } from '../src/client.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.log('Skipping client tests: TEST_DATABASE_URL not set')
  process.exit(0)
}

describe('client', () => {
  const pool = createPool({ connectionString: DATABASE_URL })

  after(() => pool.end())

  it('runs a simple query', async () => {
    const res = await query(pool, 'SELECT 1 AS n')
    assert.equal(res.rows[0].n, 1)
  })

  it('commits transactions', async () => {
    await query(pool, 'CREATE TEMP TABLE tx_test (v int)')
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO tx_test VALUES (42)')
    })
    const res = await query(pool, 'SELECT v FROM tx_test')
    assert.equal(res.rows[0].v, 42)
  })

  it('rolls back on error', async () => {
    await query(pool, 'CREATE TEMP TABLE tx_fail (v int)')
    await assert.rejects(() =>
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO tx_fail VALUES (1)')
        throw new Error('boom')
      }),
    )
    const res = await query(pool, 'SELECT count(*)::int AS c FROM tx_fail')
    assert.equal(res.rows[0].c, 0)
  })
})
