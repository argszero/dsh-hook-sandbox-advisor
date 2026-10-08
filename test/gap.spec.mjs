/**
 * The gap this package exists for, measured against the shipped articles.
 *
 * Every arm here would fail if the harness changed the behaviour the manifest
 * and the README describe — which is the point: the prose is written from these
 * measurements, so they belong in the suite rather than in a note.
 *
 * The producer is the real one. `@deepseek-ai/dsh-hook-protocol`'s `runHook` is
 * what the Claude Code and Codex bridges call, and the arms below run it, so
 * the request the plugin matches is the request the bridge builds rather than a
 * fixture written to agree with the plugin. If the bridge ever starts supplying
 * a `sandboxPolicy`, the third arm below goes red before any user is surprised.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runHook } from '@deepseek-ai/dsh-hook-protocol'
import { isHookShaped } from '../lib/index.js'
import { TOOL_REQUEST, fakeAgent, logText, noticeTexts, session, setSandboxMode, settle, world } from './harness.mjs'

/** The command hook the bridges configure. */
const HOOK = { command: 'node .claude/hooks/notify.js' }

/**
 * Run one hook through the shipped runner, inside a session's initiator
 * boundary — which is where the bridges fire it from.
 * @param harness - a harness from {@link world}.
 * @param agent - the agent whose boundary the run inherits, or undefined.
 * @param options - overrides for the runner's own options.
 * @returns the runner's own result.
 */
function runShippedHook(harness, agent, options = {}) {
  const invocation = () => runHook(
    harness.ctx.shell,
    HOOK,
    {
      payload: { hook_event_name: 'PreToolUse' },
      env: { CLAUDE_PROJECT_DIR: '/work' },
      cwd: '/work',
      signal: new AbortController().signal,
      trailingNewline: true,
      defaultTimeoutMs: 600_000,
      ...options,
    },
    () => 0,
  )
  return agent === undefined ? invocation() : harness.ctx.agents.withInitiator(agent, invocation)
}

describe('the request the bridge builds', () => {
  it('carries stdin and no sandbox policy', async () => {
    // The two halves of the plugin's detector, read off the shipped producer
    // rather than asserted about a fixture.
    const harness = await world({ plugin: false })
    await runShippedHook(harness, undefined)
    const spec = harness.shell.calls[0]
    assert.equal(typeof spec.stdin, 'string', 'the bridge always writes the JSON payload to stdin')
    assert.equal(spec.sandboxPolicy, undefined, 'and never resolves a policy')
    assert.equal(isHookShaped(spec), true)
  })

  it('matches without a workdir too, because the workdir is optional', async () => {
    const harness = await world({ plugin: false })
    await runShippedHook(harness, undefined, { cwd: undefined })
    assert.equal(harness.shell.calls[0].workdir, '/work', 'the executor supplies its own default')
    assert.equal(isHookShaped(harness.shell.calls[0]), true)
  })

  it('is told apart from a tool call, which does carry one', async () => {
    // The other side of the same seam: a tool layer resolves a policy per call
    // and passes it, so the executor receives it and the plugin must not match.
    const harness = await world({ plugin: false })
    const spec = harness.ctx.shell.resolve(TOOL_REQUEST)
    await harness.ctx.shell.execute(spec)
    assert.equal(harness.shell.calls[0].sandboxPolicy.mode, 'workspace-write')
    assert.equal(isHookShaped(harness.shell.calls[0]), false)
  })
})

describe('what the policy service answers', () => {
  it('falls back to the deployment default for a call with no session', async () => {
    const harness = await world({ plugin: false, deploymentMode: 'workspace-write' })
    assert.equal(harness.sandboxPolicy.resolve({}).mode, 'workspace-write')
  })

  it('answers the session\'s own mode for a call that threads one in', async () => {
    // The asymmetry in one pair of lines: the same service, the same
    // deployment, two answers. The hook request is the first shape; a tool call
    // is the second.
    const harness = await world({ plugin: false, deploymentMode: 'workspace-write' })
    const live = session(harness, 'wider')
    setSandboxMode(live, 'danger-full-access')
    assert.equal(harness.sandboxPolicy.resolve({ session: live }).mode, 'danger-full-access')
  })

  it('is not consulted by the runner at all', async () => {
    // The runner is session-free by design, so the executor it calls receives
    // no session to resolve with — which is why the fallback is the deployment
    // default and not a bug in the resolution.
    const harness = await world({ plugin: false, deploymentMode: 'read-only' })
    const live = session(harness, 'ignored')
    setSandboxMode(live, 'danger-full-access')
    const agent = fakeAgent(live, [])
    await runShippedHook(harness, agent)
    assert.equal(harness.shell.calls[0].sandboxPolicy, undefined)
    assert.equal(harness.shell.calls[0].stdin.length > 0, true)
  })
})

describe('the silence, and its end', () => {
  it('produces no notice and no log line without the plugin', async () => {
    // The control arm: if the harness ever starts reporting this itself, the
    // plugin is no longer needed and this arm says so.
    const harness = await world({ plugin: false, deploymentMode: 'workspace-write', answer: { exitCode: 1, stderr: 'spawn EPERM' } })
    const live = session(harness, 'silent')
    setSandboxMode(live, 'danger-full-access')
    const result = await runShippedHook(harness, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 0)
    assert.equal(logText(harness.logged), '')
    assert.equal(result.output.decision ?? 'none', 'none', 'the runner reports only the hook\'s own outcome')
  })

  it('reports the same shipped run once the plugin is mounted', async () => {
    // The integration arm: the shipped producer, the shipped registry, the
    // shipped policy service, and the plugin — nothing hand-built in between.
    const harness = await world({ deploymentMode: 'workspace-write', answer: { exitCode: 1, stderr: 'spawn EPERM' } })
    const live = session(harness, 'reported')
    setSandboxMode(live, 'danger-full-access')
    await runShippedHook(harness, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 1)
    const text = noticeTexts(harness.notices)[0]
    assert.match(text, /- hook command: `node \.claude\/hooks\/notify\.js`/)
    assert.match(text, /- confined to: `workspace-write`/)
    assert.match(text, /- this session resolves to: `danger-full-access`/)
    assert.match(text, /- stderr: `spawn EPERM`/)
  })

  it('leaves the runner\'s own contract intact', async () => {
    // `runHook` never throws on an infrastructure failure: it turns the
    // rejection into a decoded outcome. An observer that awaited the wrong
    // handle would turn that into a crash, so the arm checks the contract still
    // holds with the plugin mounted.
    const harness = await world({ deploymentMode: 'workspace-write' })
    const live = session(harness, 'throwing')
    setSandboxMode(live, 'danger-full-access')
    const before = harness.shell.execute
    Object.defineProperty(harness.shell, 'execute', {
      value: async () => { throw new Error('preparation failed: EPERM') },
      writable: true,
      configurable: true,
    })
    const result = await runShippedHook(harness, fakeAgent(live, harness.notices))
    await settle()
    assert.match(result.output.stderr ?? '', /preparation failed: EPERM/)
    assert.equal(harness.notices.length, 0, 'no process was produced, so there is no mode to compare')
    assert.equal(typeof before, 'function')
  })
})
