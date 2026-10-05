// @vitest-environment node
/*
 * GET /api/v1/admin/worker-runs/[id] is platform-admin only (sapi-p06-worker-runs-01):
 * a stored result can carry every region's rows, e.g. attribution-gap's
 * instances[] with teammate emails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/worker-runs/[id].get'

let t: TestDb
let regionId = ''
let runId = ''

function ev(session: Session, id: string) {
  const e = {
    method: 'GET',
    path: `/api/v1/admin/worker-runs/${id}`,
    context: { params: { id } },
    node: {
      req: {
        method: 'GET',
        url: `/api/v1/admin/worker-runs/${id}`,
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}

const session = (role: Session['role']): Session => ({
  teammateId: '9a1e0000-0000-4000-8000-0000000000a1',
  email: `${role}@x.test`,
  displayName: role,
  role,
  regionId,
  orgPath: 'wrd.svc',
})

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('wrd', 'WRD') RETURNING id::text AS id`
  regionId = r!.id
  const result = { instances: [{ instanceId: 'i-1', email: 'other.region@x.test', gapHours: 30 }] }
  const [run] = await t.client<{ id: string }[]>`
    INSERT INTO worker_run (worker_name, status, finished_at, duration_ms, result)
    VALUES ('attribution-gap', 'success', now(), 10, ${JSON.stringify(result)}::jsonb)
    RETURNING id::text AS id`
  runId = run!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('GET worker-runs/[id] — platform-admin only', () => {
  it('a region admin is 403', async () => {
    await expect(handler(ev(session('admin'), runId))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('platform-admin gets the full stored result', async () => {
    const res = (await handler(ev(session('platform-admin'), runId))) as { id: string; result: { instances: unknown[] } }
    expect(res.id).toBe(runId)
    expect(res.result.instances).toHaveLength(1)
  })
})
