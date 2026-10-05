/**
 * copilot-forwarder — unit tests for readNewSpans + offset tracking (L5)
 *
 * These tests guard the core file-tail + offset-persistence logic:
 *   - readNewSpans reads only new data (correct offset advancing)
 *   - persistOffset + loadPersistedOffset round-trip (M3 guard)
 *   - File shrink resets offset (L2 guard — prevents silent "skip forever")
 *   - Inode change resets offset (L2 guard — handles file recreation)
 *
 * All tests use temp files; no network, no Azure, no daemon spawning.
 * The forwarder exports these functions specifically to make this suite possible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, writeSync, openSync, closeSync, symlinkSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The forwarder reads TOKENSCOPE_FWD_OFFSET_FILE ONCE at module load, so the
// override must be in place BEFORE the dynamic import — setting it in beforeEach
// (the old shape) was too late and the suite silently round-tripped through the
// developer's real ~/.tokenscope/forwarder-offset.
const suiteDir = mkdtempSync(join(tmpdir(), 'ts-fwd-suite-'))
const offsetFile = join(suiteDir, 'forwarder-offset')
process.env.TOKENSCOPE_FWD_OFFSET_FILE = offsetFile

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const {
  readNewSpans, loadPersistedOffset, persistOffset, _resetStateForTest, clampForwardIntervalMs,
  isForeignOwned, isGitTracked, readAndForward, projectLocalDirRedirected,
} = await import('../../../plugin/scripts/copilot-forwarder.mjs')

// ── Shared span line builders ─────────────────────────────────────────────────
function chatSpanLine(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'span',
    name: 'chat claude-sonnet-4.6',
    spanId: `span-${Math.random().toString(36).slice(2, 10)}`,
    startTime: [1780825134, 0],
    endTime: [1780825137, 0],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'claude-sonnet-4.6',
      'gen_ai.conversation.id': 'test-conv',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 5,
      'github.copilot.nano_aiu': 1000000000,
      ...overrides,
    },
    resource: { attributes: {} },
    ...overrides,
  })
}

function invokeAgentSpanLine() {
  return JSON.stringify({
    type: 'span',
    name: 'invoke_agent',
    spanId: 'invoke-span',
    attributes: { 'gen_ai.operation.name': 'invoke_agent' },
    resource: { attributes: {} },
  })
}

/** Initialise `root` as a real git work tree (no identity config needed for `git add`). */
function initGitRepo(root: string) {
  execFileSync('git', ['init', '-q'], { cwd: root })
}

// ── Test setup ────────────────────────────────────────────────────────────────
let dir: string
let spanFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-fwd-'))
  spanFile = join(dir, 'copilot-otel.ndjson')
  rmSync(offsetFile, { force: true }) // fresh persisted-offset state per test
  _resetStateForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('clampForwardIntervalMs — PLG-7 garbage-interval guard', () => {
  it('passes a sane numeric interval through (number or numeric string)', () => {
    expect(clampForwardIntervalMs(5_000)).toBe(5_000)
    expect(clampForwardIntervalMs('30000')).toBe(30_000)
  })
  it('clamps NaN/garbage to 60s (was: setInterval(fn, NaN) → 1ms hot loop)', () => {
    expect(clampForwardIntervalMs('bogus')).toBe(60_000)
    expect(clampForwardIntervalMs(NaN)).toBe(60_000)
    expect(clampForwardIntervalMs('')).toBe(60_000) // Number('') === 0 → not > 0
  })
  it('clamps zero/negative/Infinity (a non-positive interval breaks the heartbeat math)', () => {
    expect(clampForwardIntervalMs(0)).toBe(60_000)
    expect(clampForwardIntervalMs(-5)).toBe(60_000)
    expect(clampForwardIntervalMs(Infinity)).toBe(60_000)
  })
  it('floors sub-second positives (1.5ms would still be a hot loop)', () => {
    expect(clampForwardIntervalMs(1.5)).toBe(60_000)
    expect(clampForwardIntervalMs(999)).toBe(60_000)
    expect(clampForwardIntervalMs(1_000)).toBe(1_000)
  })
  it('defaults to 60s when the env var is unset', () => {
    expect(clampForwardIntervalMs(undefined)).toBe(60_000)
  })
  it('a clamped value keeps HEARTBEAT_STALE_MS finite (singleton guard intact)', () => {
    // HEARTBEAT_STALE_MS = max(2.5 * interval, 150_000); with the old NaN this
    // was NaN → isAlreadyRunning() never true → daemon-per-session spawn storm.
    const stale = Math.max(2.5 * clampForwardIntervalMs('garbage'), 150_000)
    expect(Number.isFinite(stale)).toBe(true)
  })
})

describe('readNewSpans — basic tailing', () => {
  it('returns empty array when file does not exist', () => {
    const spans = readNewSpans(spanFile)
    expect(spans).toEqual([])
  })

  it('reads chat spans from a new file', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes['gen_ai.operation.name']).toBe('chat')
  })

  it('excludes invoke_agent spans (double-count guard)', () => {
    writeFileSync(spanFile, invokeAgentSpanLine() + '\n')
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(0)
  })

  it('advances offset — second call returns only new spans', () => {
    writeFileSync(spanFile, chatSpanLine({ spanId: 'span-1' }) + '\n')
    const first = readNewSpans(spanFile)
    expect(first).toHaveLength(1)

    // Append another span
    const fd = openSync(spanFile, 'a')
    writeSync(fd, chatSpanLine({ spanId: 'span-2' }) + '\n')
    closeSync(fd)

    const second = readNewSpans(spanFile)
    expect(second).toHaveLength(1)
    expect(second[0].spanId).toBe('span-2')
  })

  it('returns empty array when no new data', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    readNewSpans(spanFile) // consume
    const second = readNewSpans(spanFile)
    expect(second).toHaveLength(0)
  })

  it('handles partial lines (buffers incomplete JSON until next read)', () => {
    const line = chatSpanLine() + '\n'
    // Write only half the line
    const half = line.slice(0, Math.floor(line.length / 2))
    writeFileSync(spanFile, half)
    const partial = readNewSpans(spanFile)
    expect(partial).toHaveLength(0) // no complete line yet

    // Write the rest
    const fd = openSync(spanFile, 'a')
    writeSync(fd, line.slice(Math.floor(line.length / 2)))
    closeSync(fd)
    const complete = readNewSpans(spanFile)
    expect(complete).toHaveLength(1)
  })
})

describe('offset persistence — M3 + L2 guards', () => {
  it('persistOffset + loadPersistedOffset round-trip restores offset', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    readNewSpans(spanFile) // advances offset
    persistOffset(spanFile)

    // Reset state and reload
    _resetStateForTest()
    loadPersistedOffset(spanFile)

    // Should have no new spans (offset restored to end of file)
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(0)
  })

  it('persistOffset + loadPersistedOffset with new spans — only new spans returned', () => {
    writeFileSync(spanFile, chatSpanLine({ spanId: 'old-span' }) + '\n')
    readNewSpans(spanFile)
    persistOffset(spanFile)

    // Simulate a new process loading the offset
    _resetStateForTest()
    loadPersistedOffset(spanFile)

    // Append a new span
    const fd = openSync(spanFile, 'a')
    writeSync(fd, chatSpanLine({ spanId: 'new-span' }) + '\n')
    closeSync(fd)

    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('new-span')
  })

  it('L2: file shrink resets offset (never skip-forever on truncation)', () => {
    // Write and consume spans to advance offset
    writeFileSync(spanFile, chatSpanLine({ spanId: 'old' }) + '\n')
    readNewSpans(spanFile) // offset now at end (e.g. 200 bytes)

    // Simulate file truncation/recreation (smaller file)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'new' }) + '\n')
    // File is recreated at a small size (triggers shrink detection)
    // Force the file to be smaller by rewriting with a short line
    writeFileSync(spanFile, JSON.stringify({ type: 'span', name: 'chat', spanId: 'small',
      attributes: { 'gen_ai.operation.name': 'chat' }, resource: {} }) + '\n')

    // If the new file is smaller than our module offset, the shrink guard fires.
    // In this test the new file's content was written fresh so its size may vary.
    // We test by explicitly checking that readNewSpans doesn't return empty forever:
    // reset offset to a value larger than the file to simulate shrink scenario.
    // (The shrink guard runs: if st.size < offset → reset)
    _resetStateForTest()
    // Manually simulate a large stale offset by reading a bigger file first
    const bigContent = (chatSpanLine() + '\n').repeat(50) // ~10KB
    writeFileSync(spanFile, bigContent)
    readNewSpans(spanFile) // offset now ~10KB

    // Now write a much smaller file (simulate truncation to new session)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'after-truncate' }) + '\n')

    // readNewSpans must detect shrink, reset offset, and return the new span
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('after-truncate')
  })

  it('L2: stale offset with different inode does not restore (file recreated)', () => {
    // Write and consume, then persist offset (records spanFile's inode)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'original' }) + '\n')
    readNewSpans(spanFile)
    persistOffset(spanFile)

    // Simulate recreation under a DIFFERENT inode with a coexisting file: two
    // files that exist simultaneously are guaranteed distinct inodes, whereas
    // unlink+recreate at the same path is NOT — ext4/tmpfs routinely hand the
    // freed inode straight back, which made this test flaky.
    const recreated = join(dir, 'copilot-otel-recreated.ndjson')
    writeFileSync(recreated, chatSpanLine({ spanId: 'recreated' }) + '\n')

    // Load persisted offset against the recreated file — must NOT restore
    // (stored ino belongs to the old file).
    _resetStateForTest()
    loadPersistedOffset(recreated)

    // Should read from start (offset=0) since the inode differs
    const spans = readNewSpans(recreated)
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('recreated')
  })
})

// ── S2: span-file provenance (the committed-file vector) ──────────────────────
// Root cause: on the FIRST run in a fresh clone the offset starts at 0, so a span
// file COMMITTED INTO THE REPOSITORY is read from byte 0 and POSTed to ingest
// under the developer's own emit bearer. readNewSpans now refuses (1) a file not
// owned by this process's uid and (2) a file git tracks, BEFORE doing any read.
describe('isForeignOwned — pure uid check', () => {
  it('false when the stat uid matches this process', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    expect(isForeignOwned({ uid })).toBe(false)
  })

  it('true when the stat uid differs from this process', () => {
    if (typeof process.getuid !== 'function') return // no uid concept (Windows) — guard is a no-op there
    expect(isForeignOwned({ uid: process.getuid() + 1 })).toBe(true)
  })

  it('false (fails open) when uid is missing/non-numeric — never refuses on a malformed stat', () => {
    expect(isForeignOwned({})).toBe(false)
    expect(isForeignOwned(null)).toBe(false)
  })
})

describe('isGitTracked — pure git-tracked check', () => {
  it('false for a path outside any git repository', () => {
    expect(isGitTracked(spanFile)).toBe(false) // spanFile lives under a bare tmpdir, never a repo
  })

  it('false for a file that EXISTS in a repo but was never git add-ed (the healthy case)', () => {
    initGitRepo(dir)
    writeFileSync(spanFile, chatSpanLine() + '\n')
    expect(isGitTracked(spanFile)).toBe(false)
  })

  it('true once the file is staged — git add is enough, no commit required', () => {
    initGitRepo(dir)
    writeFileSync(spanFile, chatSpanLine() + '\n')
    execFileSync('git', ['add', 'copilot-otel.ndjson'], { cwd: dir })
    expect(isGitTracked(spanFile)).toBe(true)
  })
})

describe('readNewSpans / readAndForward — provenance guard integration', () => {
  it('refuses a git-tracked span file (root-cause scenario): readNewSpans returns nothing', () => {
    initGitRepo(dir)
    // Simulate a span file planted/committed into the repo — the exact vector a
    // fresh clone's offset-starts-at-0 behaviour exploits.
    writeFileSync(spanFile, chatSpanLine({ spanId: 'planted-in-repo' }) + '\n')
    execFileSync('git', ['add', 'copilot-otel.ndjson'], { cwd: dir })

    expect(readNewSpans(spanFile)).toEqual([])
  })

  it('readAndForward emits NOTHING for a git-tracked span file — no forward call at all', async () => {
    initGitRepo(dir)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'planted' }) + '\n')
    execFileSync('git', ['add', 'copilot-otel.ndjson'], { cwd: dir })

    const forwardFn = vi.fn().mockResolvedValue(1)
    const n = await readAndForward(spanFile, 'catch-up', forwardFn)
    expect(n).toBe(0)
    expect(forwardFn).not.toHaveBeenCalled()
  })

  it('a legitimately-appended span in an UNTRACKED file inside a git repo still forwards (no over-refusal)', () => {
    initGitRepo(dir)
    // The file exists inside a git work tree but is never staged — the healthy
    // steady state ensureGitignored maintains (.tokenscope.local/ stays ignored).
    writeFileSync(spanFile, chatSpanLine({ spanId: 'span-1' }) + '\n')
    const first = readNewSpans(spanFile)
    expect(first).toHaveLength(1)

    const fd = openSync(spanFile, 'a')
    writeSync(fd, chatSpanLine({ spanId: 'span-2' }) + '\n')
    closeSync(fd)

    const second = readNewSpans(spanFile)
    expect(second).toHaveLength(1)
    expect(second[0].spanId).toBe('span-2')
  })

  it('refuses when the span file is not owned by this process (mocked statSync — uid mismatch)', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    const realStat = fs.statSync(spanFile)
    const foreignUid = (typeof process.getuid === 'function' ? process.getuid() : 0) + 1
    vi.spyOn(fs, 'statSync').mockReturnValue({ ...realStat, uid: foreignUid } as ReturnType<typeof fs.statSync>)

    expect(readNewSpans(spanFile)).toEqual([])
  })

  it('a matching-uid stat (mocked statSync, real uid) does NOT refuse — the guard is precise, not a blanket mock-triggered refusal', () => {
    if (typeof process.getuid !== 'function') return
    writeFileSync(spanFile, chatSpanLine() + '\n')
    const realStat = fs.statSync(spanFile)
    vi.spyOn(fs, 'statSync').mockReturnValue({ ...realStat, uid: process.getuid() } as ReturnType<typeof fs.statSync>)

    expect(readNewSpans(spanFile)).toHaveLength(1)
  })
})

// client-plugins:idor:0001 — a committed symlink `.tokenscope.local -> evil/` slips
// past the git-tracked check (git refuses a pathspec beyond a symlink) and the uid
// check (the victim owns the checkout). The directory itself is refused.
describe('symlinked .tokenscope.local — refused before any read or write', () => {
  const savedCwd = process.cwd()
  afterEach(() => process.chdir(savedCwd))

  function plantSymlinkedProjectDir() {
    const evil = join(dir, 'evil')
    mkdirSync(evil)
    writeFileSync(join(evil, 'copilot-otel.jsonl'), chatSpanLine({ spanId: 'forged' }) + '\n')
    symlinkSync(evil, join(dir, '.tokenscope.local'))
    return { evil, span: join(dir, '.tokenscope.local', 'copilot-otel.jsonl') }
  }

  it('projectLocalDirRedirected: true for a symlink, false for a real dir or absent', () => {
    expect(projectLocalDirRedirected(dir)).toBe(false)
    mkdirSync(join(dir, '.tokenscope.local'))
    expect(projectLocalDirRedirected(dir)).toBe(false)
    rmSync(join(dir, '.tokenscope.local'), { recursive: true })
    plantSymlinkedProjectDir()
    expect(projectLocalDirRedirected(dir)).toBe(true)
  })

  it('readNewSpans returns nothing for a span file reached through the symlink', () => {
    initGitRepo(dir)
    const { span } = plantSymlinkedProjectDir()
    process.chdir(dir)
    expect(readNewSpans(span)).toEqual([])
  })

  it('the forwarder process refuses at startup and writes nothing under the link target', () => {
    const { evil } = plantSymlinkedProjectDir()
    const r = spawnSync(process.execPath, [resolve(__dirname, '../../../copilot-plugin/scripts/copilot-forwarder.mjs'), 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir },
      timeout: 15_000,
    })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('.tokenscope.local in')
    expect(r.stderr).toContain('is not a real directory')
    expect(readdirSync(evil)).toEqual(['copilot-otel.jsonl'])
  })
})
