// @vitest-environment node
/*
 * scripts/check-docs-references.mjs — each drift class it exists for must be
 * reported, a deliberate exception must be honoured, and the CLI must exit
 * non-zero on a finding (CI and publish.sh key off the exit code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { checkTree } from '../../../scripts/check-docs-references.mjs'

const SCRIPT = resolve(__dirname, '../../../scripts/check-docs-references.mjs')
let root: string

function write(rel: string, content: string) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'docs-check-'))
  write('package.json', JSON.stringify({ scripts: { dev: 'nuxt dev', 'db:migrate': 'x' } }))
  write('infra/main.bicep', "param frontDoorSku string = 'Standard'\noutput containerAppUrl string = ''\n")
  write(
    'infra/modules/container-app.bicep',
    "{ name: 'NUXT_ANTHROPIC_KEY_MAIN', secretRef: 'k' }\n{ name: 'NUXT_GITHUB_PAT_ENTERPRISE_NFR', secretRef: 'g' }\n",
  )
  write('infra/parameters/example-sandbox.bicepparam', "param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')\n")
  write('server/uses.ts', "process.env.NUXT_SESSION_SECRET\n")
  write('docs/ok.md', 'Run `npm run dev` and `npm run test:*`. See [ok](ok.md) and `infra/main.bicep`.\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const messages = () => checkTree(root).map((p: { file: string; message: string }) => `${p.file}: ${p.message}`)

describe('check-docs-references', () => {
  it('passes a tree whose docs only reference things that exist', () => {
    expect(messages()).toEqual([])
  })

  it('reports an npm script, a repo path and a link that do not exist', () => {
    write('docs/bad.md', 'Run `npm run db:seed`, open `scripts/gone.mjs`, read [x](missing.md).\n')
    const m = messages().join('\n')
    expect(m).toContain('npm script "db:seed" does not exist')
    expect(m).toContain('path "scripts/gone.mjs" does not exist')
    expect(m).toContain('link target "missing.md" does not exist')
  })

  it('reports a NUXT_ variable no code reads', () => {
    write('docs/env.md', 'Set `NUXT_SESSION_SECRET` and `NUXT_RETIRED_FLAG`.\n')
    const m = messages().join('\n')
    expect(m).toContain('NUXT_RETIRED_FLAG is not mentioned')
    expect(m).not.toContain('NUXT_SESSION_SECRET')
  })

  it('reports deploy-doc parameters and secrets variables the template or examples do not have', () => {
    write('docs/DEPLOY-AZURE.md', 'Set `frontDoorSku = \'Premium\'`, `appPublicOrigin`, `PG_ADMIN_PASSWORD` and `GH_PAT_RENAMED`.\n')
    const m = messages().join('\n')
    expect(m).toContain('"appPublicOrigin" is not a parameter or output')
    expect(m).toContain('secrets variable GH_PAT_RENAMED is not read')
    expect(m).not.toContain('frontDoorSku')
    expect(m).not.toContain('PG_ADMIN_PASSWORD')
  })

  it('does not count a workflow mapping a secret as the deployment reading it', () => {
    write('examples/github-actions/infra.yml', 'env:\n  GH_PAT_RENAMED: ${{ secrets.GH_PAT_RENAMED }}\n  PG_ADMIN_PASSWORD: ${{ secrets.PG_ADMIN_PASSWORD }}\n')
    write('docs/DEPLOY-AZURE.md', 'Set `GH_PAT_RENAMED`.\n')
    const m = messages().join('\n')
    expect(m).toContain('docs/DEPLOY-AZURE.md: secrets variable GH_PAT_RENAMED is not read')
    expect(m).toContain('examples/github-actions/infra.yml: secret GH_PAT_RENAMED is passed to the deployment but no example parameter file reads it')
    expect(m).not.toContain('PG_ADMIN_PASSWORD')
  })

  it('matches variable names whole, not as a prefix of a longer one', () => {
    write('docs/env.md', 'Set `NUXT_SESSION`.\n')
    expect(messages().join('\n')).toContain('NUXT_SESSION is not mentioned')
  })

  it('reports a credential name that maps to no wired key, including when the phrase wraps', () => {
    write(
      'docs/DEPLOY-AZURE.md',
      'The app reads it under the credential name\n  `insight`: use that name.\n\n| `GH_PAT_X` | `enterprise-nfr` |\n| `GH_PAT_Y` | `enterprise-nfr` |\n',
    )
    const m = messages().join('\n')
    expect(m).toContain('credential name "insight" maps to no key')
    expect(m).not.toContain('"enterprise-nfr" maps')
  })

  it('honours an ignore marker on the line or the line above', () => {
    write('docs/ignored.md', '<!-- docs-check: ignore (a file you create) -->\nCreate `infra/parameters/mine.bicepparam`.\n')
    expect(messages()).toEqual([])
  })

  it('skips docs the publish drops', () => {
    write('tools/publish/internal-only-paths.txt', 'docs/internal.md\n')
    write('docs/internal.md', 'Run `npm run nothing-here`.\n')
    expect(messages()).toEqual([])
  })

  it('exits 1 with findings and 0 when clean', () => {
    const clean = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    expect(clean.status).toBe(0)
    write('docs/bad.md', 'Run `npm run db:seed`.\n')
    const dirty = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    expect(dirty.status).toBe(1)
    expect(dirty.stderr).toContain('db:seed')
  })
})
