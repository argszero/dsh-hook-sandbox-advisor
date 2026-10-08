/**
 * What the mounted advisor does, measured against the shipped services.
 *
 * The arms are grouped by the claim each one would falsify:
 *
 * - **the observation** — a hook confined more tightly than its session is
 *   reported, with both modes named; a hook at its session's own policy is not,
 *   unless it was refused or the deployment asked to hear about equal runs.
 * - **what it must not do** — a tool call is untouched, an unsandboxed executor
 *   is never reported, a change to no policy is made, the executor is not
 *   rewritten, and the class is not patched.
 * - **the caller's own handling** — the handle and the spec come back exactly
 *   as the executor produced them, including when this plugin's own reporting
 *   fails.
 * - **config** — every bound and switch, and the values that fall back.
 * - **the decision** — the pure branches, reachable without a harness.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boundExcerpt, isHookShaped, isNarrower, normalizeConfig, rankOf, renderHostNote, renderNotice } from '../lib/index.js'
import {
  HOOK_REQUEST, TOOL_REQUEST, breakResolve, fakeAgent, logText, noticeTexts, runInSession,
  session, setSandboxMode, settle, world,
} from './harness.mjs'

/** A session running wider than the deployment default, with a hook run inside it. */
async function narrowedRun(harnessOptions = {}) {
  const harness = await world({ deploymentMode: 'workspace-write', ...harnessOptions })
  const live = session(harness, 's1')
  setSandboxMode(live, 'danger-full-access')
  const agent = fakeAgent(live, harness.notices)
  const execution = await runInSession(harness, HOOK_REQUEST, agent)
  await settle()
  return { harness, live, agent, execution }
}

describe('the observation', () => {
  it('reports a hook confined more tightly than the session that fired it', async () => {
    const { harness } = await narrowedRun({ answer: { exitCode: 1, stderr: 'spawn EPERM' } })
    assert.equal(harness.notices.length, 1, 'exactly one notice')
    const text = noticeTexts(harness.notices)[0]
    assert.match(text, /^A hook ran under a narrower file policy than the session that fired it\./)
    assert.match(text, /- hook command: `node \.claude\/hooks\/notify\.js`/)
    assert.match(text, /- confined to: `workspace-write`/, 'the mode the run was actually confined to')
    assert.match(text, /- this session resolves to: `danger-full-access`/, 'the mode it should have had')
    assert.match(text, /- outcome: exited 1/)
    assert.match(text, /- stderr: `spawn EPERM`/)
  })

  it('stamps the notice with an identity of its own, not the generic plugin kind', async () => {
    const { harness } = await narrowedRun()
    assert.equal(harness.notices[0].source.kind, 'hook-sandbox-advisor')
  })

  it('says nothing when the hook ran at its session\'s own policy', async () => {
    const harness = await world({ deploymentMode: 'workspace-write' })
    const live = session(harness, 'equal')
    await runInSession(harness, HOOK_REQUEST, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 0, 'the fallback costs this deployment nothing')
    assert.equal(logText(harness.logged), '')
  })

  it('reports a refusal even when the modes agree', async () => {
    // A deployment whose sessions already run at the default loses nothing to
    // the fallback — so a quiet arm above is correct — but a run the sandbox
    // actually REFUSED is a different fact and is reported anyway.
    const harness = await world({ deploymentMode: 'workspace-write', answer: { exitCode: 1, denied: true } })
    const live = session(harness, 'denied')
    await runInSession(harness, HOOK_REQUEST, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 1)
    const text = noticeTexts(harness.notices)[0]
    assert.match(text, /^A hook was refused by the sandbox\./)
    assert.match(text, /- outcome: the sandbox refused a file operation; exited 1/)
    assert.doesNotMatch(text, /narrower file policy/, 'a refusal at the session\'s own policy is not a fallback defect')
  })

  it('reports an equal-mode run when the deployment asks for it', async () => {
    const harness = await world({ deploymentMode: 'workspace-write', config: { reportEqual: true } })
    const live = session(harness, 'equal-reported')
    await runInSession(harness, HOOK_REQUEST, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 1)
    const text = noticeTexts(harness.notices)[0]
    assert.match(text, /^A hook ran confined, at the same policy as the session that fired it\./)
    assert.match(text, /reportEqual/)
  })

  it('takes the mode from the run\'s own report, not from the executor\'s declared default', async () => {
    // The executor declares `workspace-write`; the run reports `read-only`. The
    // run's own account is the one that outranks, so this is reported as a
    // narrowing even though the two sources disagree.
    const { harness } = await narrowedRun({ answer: { mode: 'read-only' } })
    assert.match(noticeTexts(harness.notices)[0], /- confined to: `read-only`/)
  })

  it('names every outcome the shell result can carry', async () => {
    const cases = [
      [{ timedOut: true }, /the executor deadline expired/],
      [{ aborted: true }, /the caller aborted it/],
      [{ signal: 'SIGKILL' }, /killed by SIGKILL/],
      [{ runnerFailed: true }, /the sandbox runner failed/],
      [{ exitCode: 0 }, /outcome: completed normally/],
    ]
    for (const [answer, expected] of cases) {
      const { harness } = await narrowedRun({ answer })
      assert.match(noticeTexts(harness.notices)[0], expected, JSON.stringify(answer))
    }
  })

  it('reports a run with no session to the host log, and to no session', async () => {
    // `SessionStart`, `SubagentStart` and `SubagentStop` run outside any turn,
    // so there is no agent to notify and no `hook/*` record either — the host
    // log is the only channel left, and saying so is the honest coverage.
    const harness = await world({ deploymentMode: 'danger-full-access' })
    await harness.ctx.shell.execute(harness.ctx.shell.resolve(HOOK_REQUEST))
    await settle()
    assert.equal(harness.notices.length, 0, 'there is no session to inject into')
    const text = logText(harness.logged)
    assert.match(text, /^a hook with no session ran confined to workspace-write, narrower than the deployment default danger-full-access/)
    assert.match(text, /no session to notify and no hook\/\* record exists for this point/)
    assert.match(text, /command: node \.claude\/hooks\/notify\.js/)
  })

  it('notices a session once, and once more per run when asked', async () => {
    const { harness, live, agent } = await narrowedRun()
    await runInSession(harness, HOOK_REQUEST, agent)
    await settle()
    assert.equal(harness.notices.length, 1, 'the condition is the session\'s posture, not the run\'s')

    const repeating = await world({ deploymentMode: 'workspace-write', config: { repeat: true } })
    const live2 = session(repeating, 's2')
    setSandboxMode(live2, 'danger-full-access')
    const agent2 = fakeAgent(live2, repeating.notices)
    await runInSession(repeating, HOOK_REQUEST, agent2)
    await runInSession(repeating, HOOK_REQUEST, agent2)
    await settle()
    assert.equal(repeating.notices.length, 2, 'and `repeat` is what turns one notice into one per run')
    assert.equal(live.id, 's1')
  })

  it('says so, once, when a session\'s mode cannot be resolved', async () => {
    // Falling back to the deployment default keeps the comparison from claiming
    // a narrowing it cannot source — but doing it silently would reproduce the
    // very failure this plugin exists to name.
    const { harness, agent } = await narrowedRun({ deploymentMode: 'danger-full-access' })
    breakResolve(harness, 'the projection is unavailable')
    await runInSession(harness, HOOK_REQUEST, agent)
    await runInSession(harness, HOOK_REQUEST, agent)
    await settle()
    const text = logText(harness.logged)
    assert.equal(text.match(/has no resolvable sandbox mode/g).length, 1, 'once per session, not once per run')
    assert.match(text, /compared against the deployment default/)
    assert.match(text, /the projection is unavailable/)
  })
})

describe('what the advisor must not do', () => {
  it('leaves a tool-shaped call alone', async () => {
    // The tool layers resolve a policy per call and pass it; only the hook
    // request arrives without one. A plugin that reported tool calls too would
    // be pure noise on every deployment.
    const harness = await world({ deploymentMode: 'workspace-write' })
    const live = session(harness, 'tool-call')
    setSandboxMode(live, 'danger-full-access')
    const execution = await runInSession(harness, TOOL_REQUEST, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 0)
    assert.equal(logText(harness.logged), '')
    assert.equal(execution.sandbox.mode, 'workspace-write', 'and the call is still executed')
  })

  it('says nothing when the executor does not sandbox at all', async () => {
    // Read from the executor rather than assumed: a deployment with no sandbox
    // provider mounted has no confinement to warn about.
    const harness = await world({ sandboxMode: null })
    const live = session(harness, 'unsandboxed')
    setSandboxMode(live, 'danger-full-access')
    await runInSession(harness, HOOK_REQUEST, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 0)
    assert.equal(logText(harness.logged), '')
  })

  it('returns the executor\'s own handle and the caller\'s own spec', async () => {
    // The wrapper is an observer: a caller's background producer must keep the
    // identity and the read paths the executor produced, and the executor must
    // be handed exactly what it was handed before this plugin existed.
    const { harness, execution } = await narrowedRun({ answer: { exitCode: 3, stderr: 'EPERM' } })
    assert.deepEqual(execution.sandbox, { mode: 'workspace-write', denied: false })
    assert.equal((await execution.result()).exitCode, 3)
    assert.deepEqual(harness.shell.calls[0], harness.ctx.shell.resolve(HOOK_REQUEST),
      'the executor received the spec it resolves, unchanged')
  })

  it('shadows the instance method without patching the class', async () => {
    // Load-bearing: cordis resolves a method by walking the prototype chain
    // from the raw instance on every read, so an own property is what makes the
    // bridge — which reaches the executor through the same `ctx.shell` view —
    // land on the wrapper. A class-level patch would leak into every other
    // context that shares the class.
    const harness = await world({ deploymentMode: 'workspace-write' })
    assert.ok(Object.getOwnPropertyDescriptor(harness.shell, 'execute'), 'the wrapper is an own property of the instance')
    assert.equal(Object.getPrototypeOf(harness.shell).execute, harness.prototypeExecute, 'the class is untouched')
    assert.notEqual(harness.ctx.shell.execute, harness.prototypeExecute, 'and the view presents the wrapper')
  })

  it('installs nothing in `off` mode', async () => {
    const harness = await world({ deploymentMode: 'workspace-write', config: { mode: 'off' } })
    assert.equal(Object.getOwnPropertyDescriptor(harness.shell, 'execute'), undefined)
    const live = session(harness, 'off')
    setSandboxMode(live, 'danger-full-access')
    await runInSession(harness, HOOK_REQUEST, fakeAgent(live, harness.notices))
    await settle()
    assert.equal(harness.notices.length, 0)
  })

  it('contains a failure of its own delivery instead of failing the caller', async () => {
    // The whole point is to make a silent failure visible, so a failure in the
    // reporting path must not become a second silent one.
    const harness = await world({ deploymentMode: 'workspace-write' })
    const live = session(harness, 'refusing-agent')
    setSandboxMode(live, 'danger-full-access')
    const agent = { session: live, inject: () => { throw new Error('this session is closed') } }
    const execution = await runInSession(harness, HOOK_REQUEST, agent)
    await settle()
    assert.equal(execution.sandbox.mode, 'workspace-write', 'the caller still gets its handle')
    assert.match(logText(harness.logged), /could not deliver the hook notice: Error: this session is closed/)
  })
})

describe('config', () => {
  it('leaves the stderr out when asked to', async () => {
    const { harness } = await narrowedRun({ answer: { exitCode: 1, stderr: 'spawn EPERM' }, config: { includeStderr: false } })
    const text = noticeTexts(harness.notices)[0]
    assert.doesNotMatch(text, /spawn EPERM/)
    assert.doesNotMatch(text, /- stderr:/)
  })

  it('bounds the command line and the stderr excerpt on their own', async () => {
    // The notice bound is deliberately huge here: with all three small, only the
    // outermost cap bites and the two inner ones would be free to be absent.
    const { harness } = await narrowedRun({
      answer: { exitCode: 1, stderr: 'y'.repeat(300) },
      config: { commandMaxChars: 12, stderrMaxChars: 20, noticeMaxChars: 10_000 },
    })
    const text = noticeTexts(harness.notices)[0]
    assert.match(text, /- hook command: `node .claud…`/, 'the command line is cut at its own bound')
    assert.match(text, /- stderr: `y{19}…`/, 'and the stderr excerpt at its own')
    assert.ok(text.length > 200, 'and neither cut is the notice bound pretending to be them')
  })

  it('bounds the notice itself', async () => {
    const long = 'x'.repeat(300)
    const { harness } = await narrowedRun({
      answer: { exitCode: 1, stderr: long },
      config: { commandMaxChars: 12, stderrMaxChars: 20, noticeMaxChars: 60 },
    })
    const text = noticeTexts(harness.notices)[0]
    assert.ok(text.length <= 60, `the notice is bounded, saw ${text.length}`)
    assert.match(text, /…$/, 'and the cut is marked')
  })

  it('bounds the host note separately from the session notice', async () => {
    const harness = await world({
      deploymentMode: 'danger-full-access',
      config: { hostNoteMaxChars: 40, noticeMaxChars: 2000 },
    })
    await harness.ctx.shell.execute(harness.ctx.shell.resolve(HOOK_REQUEST))
    await settle()
    const text = logText(harness.logged)
    assert.ok(text.length <= 40, `the host note is bounded, saw ${text.length}`)
  })

  it('falls back for an unusable bound rather than propagating it', () => {
    // `0` would silently disable the thing it bounds and `NaN` would make every
    // comparison false; both are caller text like any other.
    const settings = normalizeConfig({ noticeMaxChars: 0, stderrMaxChars: Number.NaN, commandMaxChars: -5 })
    assert.equal(settings.noticeMaxChars, 2000)
    assert.equal(settings.stderrMaxChars, 400)
    assert.equal(settings.commandMaxChars, 160)
  })

  it('resolves every switch and rejects the values that are not switches', () => {
    assert.deepEqual(normalizeConfig({}), {
      mode: 'notice', reportEqual: false, repeat: false, includeStderr: true,
      commandMaxChars: 160, stderrMaxChars: 400, noticeMaxChars: 2000, hostNoteMaxChars: 500,
    })
    assert.equal(normalizeConfig({ mode: 'off' }).mode, 'off')
    assert.equal(normalizeConfig({ mode: 'nonsense' }).mode, 'notice', 'an unknown mode is not a third mode')
    assert.equal(normalizeConfig({ reportEqual: 'yes' }).reportEqual, false)
    assert.equal(normalizeConfig({ repeat: 1 }).repeat, false)
  })
})

describe('the decision', () => {
  it('orders the three modes', () => {
    assert.ok(rankOf('read-only') < rankOf('workspace-write'))
    assert.ok(rankOf('workspace-write') < rankOf('danger-full-access'))
  })

  it('calls a narrowing a narrowing, and an equal policy not one', () => {
    assert.equal(isNarrower('workspace-write', 'danger-full-access'), true)
    assert.equal(isNarrower('read-only', 'workspace-write'), true)
    assert.equal(isNarrower('workspace-write', 'workspace-write'), false, 'equal is not narrower')
    assert.equal(isNarrower('danger-full-access', 'workspace-write'), false)
  })

  it('matches the hook shape and nothing else', () => {
    assert.equal(isHookShaped(HOOK_REQUEST), true)
    assert.equal(isHookShaped(TOOL_REQUEST), false, 'a policy means the caller resolved one')
    assert.equal(isHookShaped({ command: 'ls' }), false, 'neither marker')
    assert.equal(isHookShaped({ command: 'ls', stdin: 'x', sandboxPolicy: { mode: 'read-only' } }), false,
      'and a future bridge that starts supplying a policy stops matching on its own')
  })

  it('bounds an excerpt without inventing characters', () => {
    assert.equal(boundExcerpt('  spaced  ', 20), 'spaced')
    assert.equal(boundExcerpt('abcdef', 3), 'ab…')
    assert.equal(boundExcerpt('abcdef', 6), 'abcdef')
    assert.equal(boundExcerpt('abcdef', 0), '', 'a non-positive bound keeps nothing')
  })

  it('renders the host note with and without a narrowing', () => {
    const facts = {
      command: 'hook.sh', mode: 'read-only', rank: 0, exitCode: 1, signal: null,
      timedOut: false, aborted: false, denied: false, runnerFailed: false, stderrExcerpt: 'nope',
    }
    assert.match(renderHostNote(facts, 'read-only', 'danger-full-access', true, 500),
      /narrower than the deployment default danger-full-access/)
    assert.doesNotMatch(renderHostNote(facts, 'read-only', 'read-only', false, 500), /narrower than/)
  })

  it('chooses the notice text from the reason, not from the modes alone', () => {
    const facts = {
      command: 'hook.sh', mode: 'workspace-write', rank: 1, exitCode: 1, signal: null,
      timedOut: false, aborted: false, denied: false, runnerFailed: false, stderrExcerpt: undefined,
    }
    assert.match(renderNotice(facts, 'workspace-write', 'danger-full-access', true, 4000), /narrower file policy/)
    assert.match(renderNotice(facts, 'workspace-write', 'workspace-write', false, 4000), /same policy as the session/)
    assert.match(renderNotice({ ...facts, denied: true }, 'workspace-write', 'workspace-write', false, 4000),
      /refused by the sandbox/)
  })

  it('omits the stderr line rather than printing an empty one', () => {
    const facts = {
      command: 'hook.sh', mode: 'workspace-write', rank: 1, exitCode: 0, signal: null,
      timedOut: false, aborted: false, denied: false, runnerFailed: false, stderrExcerpt: '',
    }
    assert.doesNotMatch(renderNotice(facts, 'workspace-write', 'danger-full-access', true, 4000), /- stderr:/)
  })
})
