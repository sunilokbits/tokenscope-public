/*
 * otel-headers-helper.sh — the emit ACCESS token never rides on curl's argv
 * (cpl:auth:0003 / SS-CP-3 / cpl:ts:0001): argv is readable by every local user
 * via `ps` and /proc. It goes to curl on stdin (`-H @-`), as the refresh token
 * already does (`--data-binary @-`).
 *
 * Driven with a stub `curl` that logs its argv AND its stdin, for both vendored
 * copies of the helper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const HELPERS = {
  claude: resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh'),
  copilot: resolve(__dirname, '../../../copilot-plugin/scripts/otel-headers-helper.sh'),
}

const ACCESS = 'stub-access-SECRET-7f3a'

// Logs "ARGV <argv>" and, for the /bearer call, "STDIN <stdin>".
const STUB = `#!/bin/sh
a="$*"
printf 'ARGV %s\\n' "$a" >> "$STUB_LOG"
case "$a" in
  *"/oauth/token"*)
    cat >/dev/null 2>&1 || true
    printf '{"access_token":"${ACCESS}","expires_in":3600}\\n200' ;;
  *"/bearer"*)
    printf 'STDIN %s\\n' "$(cat)" >> "$STUB_LOG"
    printf '{"Authorization":"Bearer stub-bearer"}\\n200' ;;
  *) printf '\\n000' ;;
esac
exit 0
`

let tmp: string
let stubDir: string
let stateDir: string
let log: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-helper-argv-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  log = join(tmp, 'curl.log')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(join(stubDir, 'curl'), STUB)
  chmodSync(join(stubDir, 'curl'), 0o755)
  // Point the passwd-home lookup at an empty temp home, so the developer's real
  // enrolment is never read.
  const passwdHome = join(tmp, 'passwd-home')
  mkdirSync(passwdHome, { recursive: true })
  writeFileSync(join(stubDir, 'id'), `#!/bin/sh\nprintf 'tsprobe\\n'\n`)
  chmodSync(join(stubDir, 'id'), 0o755)
  writeFileSync(join(stubDir, 'getent'), `#!/bin/sh\nprintf 'tsprobe:x:1000:1000::%s:/bin/sh\\n' "${passwdHome}"\n`)
  chmodSync(join(stubDir, 'getent'), 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe.each(Object.entries(HELPERS))('otel-headers-helper (%s copy) — access token off argv', (_name, src) => {
  it('sends the bearer as a header on stdin and never on argv', () => {
    const helper = join(tmp, 'otel-headers-helper.sh')
    copyFileSync(src, helper)
    const r = spawnSync('sh', [helper, '--state-dir', stateDir, '--tool-dir', stubDir], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        HOME: tmp,
        TOKENSCOPE_BEARER_ENDPOINT: 'https://stub.local/api/v1/instances/x/bearer',
        TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://stub.local/api/v1/oauth/token',
        TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
        STUB_LOG: log,
      },
    })
    expect(r.status).toBe(0)
    const lines = readFileSync(log, 'utf8').split('\n')
    const bearerArgv = lines.find((l) => l.startsWith('ARGV') && l.includes('/bearer')) ?? ''
    expect(bearerArgv).not.toBe('')
    for (const l of lines.filter((x) => x.startsWith('ARGV'))) expect(l).not.toContain(ACCESS)
    expect(bearerArgv).toContain('-H @-')
    expect(lines).toContain(`STDIN Authorization: Bearer ${ACCESS}`)
  })
})
