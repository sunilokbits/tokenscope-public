/*
 * require-front-door across deployment topologies, dispatched through a real
 * h3 app + router over a node socket so the router sees the RAW request path
 * (node:http does not resolve dot segments; fetch would).
 *
 * The route table mirrors the Nitro routes the gate fronts: /api/health,
 * the /api/v1/mcp/** catch-all, /api/v1/oauth/token, the
 * /.well-known/oauth-protected-resource/** catch-all and a /_nuxt asset
 * (the renderer's /** catch-all). Stub handlers name themselves so a bypass
 * shows up as the WRONG handler answering 200.
 *
 * Topologies (docs/DEPLOY-AZURE.md §Optional: Front Door, §4):
 *   - Front Door present: AZURE_FRONT_DOOR_ID set, X-Azure-FDID matches.
 *   - Phase 2: Front Door enabled, AZURE_FRONT_DOOR_ID still empty (no-op).
 *   - Dev: no Front Door, another proxy appends X-Forwarded-For (no-op).
 *   - Local: no env, localhost (no-op).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import middleware from '../../../server/middleware/require-front-door'

const FDID = '9a1e0000-0000-4000-8000-000000000001'

let server: Server
let port: number

beforeAll(async () => {
  const app = createApp()
  app.use(middleware)
  const router = createRouter()
    .get('/api/health', defineEventHandler(() => ({ handler: 'health' })))
    .use('/api/v1/mcp/**', defineEventHandler(() => ({ handler: 'mcp' })))
    .use('/api/v1/mcp', defineEventHandler(() => ({ handler: 'mcp' })))
    .post('/api/v1/oauth/token', defineEventHandler(() => ({ handler: 'token' })))
    .get('/.well-known/oauth-protected-resource', defineEventHandler(() => ({ handler: 'prm' })))
    .get('/.well-known/oauth-protected-resource/**', defineEventHandler(() => ({ handler: 'prm' })))
    .get('/**', defineEventHandler(() => ({ handler: 'renderer' })))
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  delete process.env.AZURE_FRONT_DOOR_ID
  delete process.env.AZURE_FRONT_DOOR_REQUIRED
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  delete process.env.AZURE_FRONT_DOOR_ID
  delete process.env.AZURE_FRONT_DOOR_REQUIRED
  warnSpy.mockRestore()
})

function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; handler: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        let handler: string | undefined
        try {
          handler = (JSON.parse(body) as { handler?: string }).handler
        } catch {
          handler = undefined
        }
        resolve({ status: res.statusCode ?? 0, handler })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Dot-segment variants the router dispatches to a catch-all while
// URL-normalisation reads them as /api/health.
const BYPASS_PATHS = [
  '/api/v1/mcp/x/../../../health',
  '/api/v1/mcp/x/%2e%2e/%2e%2e/%2e%2e/health',
  '/.well-known/oauth-protected-resource/x/../../../api/health',
  '/x/../api/health',
]

const LEGIT: Array<{ method: string; path: string; handler: string }> = [
  { method: 'POST', path: '/api/v1/mcp', handler: 'mcp' },
  { method: 'POST', path: '/api/v1/mcp/sse?sessionId=abc', handler: 'mcp' },
  { method: 'POST', path: '/api/v1/oauth/token?grant_type=refresh_token', handler: 'token' },
  { method: 'GET', path: '/.well-known/oauth-protected-resource', handler: 'prm' },
  { method: 'GET', path: '/.well-known/oauth-protected-resource/api/v1/mcp', handler: 'prm' },
  { method: 'GET', path: '/_nuxt/entry.D3adB33f.js', handler: 'renderer' },
]

function expectLegitPass(headers: Record<string, string>) {
  return Promise.all(
    LEGIT.map(async ({ method, path, handler }) => {
      const res = await send(method, path, headers)
      expect({ path, ...res }).toEqual({ path, status: 200, handler })
    }),
  )
}

describe('topology: Front Door present (AZURE_FRONT_DOOR_ID set)', () => {
  beforeEach(() => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
  })

  it('refuses every dot-segment health bypass without the header', async () => {
    for (const path of BYPASS_PATHS) {
      for (const method of ['GET', 'POST']) {
        const res = await send(method, path)
        expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 })
      }
    }
  })

  it('still exempts the exact /api/health probe (with and without a query)', async () => {
    expect(await send('GET', '/api/health')).toEqual({ status: 200, handler: 'health' })
    expect(await send('GET', '/api/health?probe=startup')).toEqual({ status: 200, handler: 'health' })
  })

  it('MCP (and a subpath), OAuth token, .well-known and /_nuxt assets pass with the Front Door header', async () => {
    await expectLegitPass({ 'x-azure-fdid': FDID })
  })

  it('the same paths are refused direct-to-origin (no header)', async () => {
    for (const { method, path } of LEGIT) {
      expect((await send(method, path)).status).toBe(403)
    }
  })
})

describe('topology: phase 2 (Front Door enabled, AZURE_FRONT_DOOR_ID empty)', () => {
  beforeEach(() => {
    process.env.AZURE_FRONT_DOOR_ID = ''
  })

  it('gate is a no-op: MCP, OAuth, .well-known and assets pass with or without the AFD header', async () => {
    await expectLegitPass({})
    await expectLegitPass({ 'x-azure-fdid': FDID })
    expect(await send('GET', '/api/health')).toEqual({ status: 200, handler: 'health' })
  })

  it('with AZURE_FRONT_DOOR_REQUIRED=true the dot-segment bypass is refused and /api/health still passes', async () => {
    process.env.AZURE_FRONT_DOOR_REQUIRED = 'true'
    for (const path of BYPASS_PATHS) {
      expect((await send('POST', path)).status).toBe(403)
    }
    expect(await send('GET', '/api/health')).toEqual({ status: 200, handler: 'health' })
  })
})

describe('topology: no Front Door, behind another proxy (Dev)', () => {
  it('gate is a no-op: MCP, OAuth, .well-known and assets pass', async () => {
    await expectLegitPass({ 'x-forwarded-for': '203.0.113.7, 10.0.0.4', 'x-forwarded-proto': 'https' })
    expect(await send('GET', '/api/health', { 'x-forwarded-for': '10.0.0.4' })).toEqual({
      status: 200,
      handler: 'health',
    })
  })
})

describe('topology: local', () => {
  it('gate is a no-op: MCP, OAuth, .well-known and assets pass', async () => {
    await expectLegitPass({ host: 'localhost:3000' })
    expect(await send('GET', '/api/health', { host: 'localhost:3000' })).toEqual({
      status: 200,
      handler: 'health',
    })
  })
})
