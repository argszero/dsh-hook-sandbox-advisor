/**
 * The integration harness: a REAL cordis context, the REAL `dsh-agent` registry
 * (so the initiator boundary is the shipped one), the REAL
 * `dsh-sandbox-policy` service (so both modes are resolved by the shipped code
 * from the shipped projection), and a REAL `ShellExecutor` subclass.
 *
 * Only the executor's *body* is a stand-in — it records what it was asked to
 * run and answers with a fabricated result. Everything the plugin's correctness
 * actually rests on is the shipped article:
 *
 * - the prototype-method shadowing, which only exists if `ctx.shell` really is a
 *   cordis service reached through a traceable view (a plain object would have
 *   proved nothing);
 * - the initiator inheritance, which is `AgentRegistry`'s AsyncLocalStorage and
 *   not this suite's idea of it;
 * - both mode lookups, which go through `SandboxPolicyService.resolve()` —
 *   including the session projection fold, so an arm can move a session's mode
 *   with the shipped `setSandboxMode` rather than by hand.
 *
 * `test/gap.spec.mjs` adds one more shipped article on top: the REAL
 * `@deepseek-ai/dsh-hook-protocol` runner, so the request the plugin matches is
 * the one the bridge actually builds rather than a fixture that agrees with it.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import * as plugin from '../lib/index.js'

/** The symbol cordis uses to carry the raw instance behind a traceable view. */
export const ORIGINAL = Symbol.for('cordis.original')

/** The shape `@deepseek-ai/dsh-hook-protocol`'s runner builds, verbatim. */
export const HOOK_REQUEST = {
  command: 'node .claude/hooks/notify.js',
  timeoutMs: 600_000,
  stdin: '{"hook_event_name":"PreToolUse"}\n',
  env: { CLAUDE_PROJECT_DIR: '/work' },
  workdir: '/work',
}

/** A tool call's request: a policy, no stdin. */
export const TOOL_REQUEST = {
  command: 'ls -la',
  sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/work' },
}

/**
 * A shell executor whose body is fabricated but whose identity is not.
 *
 * `sandboxMode`, `resolve` and `execute` are the shipped abstract class's own
 * members, so the plugin's `target.execute` shadowing is exercised against a
 * prototype method exactly as it is in a deployment.
 */
export class StubShell extends ShellExecutor {
  /**
   * @param ctx - the context to register on.
   * @param options - the fabricated answers.
   */
  constructor(ctx, options = {}) {
    super(ctx)
    this.options = options
    this.calls = []
  }

  /** The executor's declared default, or `undefined` for an unsandboxed one. */
  get sandboxMode() {
    return this.options.sandboxMode
  }

  /** Fill the spec the way an implementation would, then let the test see it. */
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? '/work',
      timeoutMs: request.timeoutMs ?? 120_000,
      onExpiry: 'kill',
      stdoutMaxBytes: 1_048_576,
      ...request,
    }
  }

  /** Record the spec and answer with the fabricated run. */
  async execute(spec) {
    this.calls.push(spec)
    const answer = typeof this.options.answer === 'function'
      ? this.options.answer(spec)
      : this.options.answer ?? {}
    const mode = answer.mode ?? this.sandboxMode
    const sandbox = this.sandboxMode === undefined
      ? undefined
      : {
        mode,
        denied: answer.denied ?? false,
        ...answer.runnerFailed === undefined ? {} : { runnerFailed: answer.runnerFailed },
      }
    return {
      status: 'completed',
      exitCode: answer.exitCode ?? 0,
      signal: answer.signal ?? null,
      done: Promise.resolve(),
      ...sandbox === undefined ? {} : { sandbox },
      result: async () => ({
        exitCode: answer.exitCode ?? 0,
        signal: answer.signal ?? null,
        timedOut: answer.timedOut ?? false,
        aborted: answer.aborted ?? false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: answer.stdout ?? '', truncated: false, lossy: false },
        stderr: { text: answer.stderr ?? '', truncated: false, lossy: false },
        ...sandbox === undefined ? {} : { sandbox },
      }),
    }
  }
}

/**
 * Mount the real harness, and by default this plugin.
 * @param spec - `plugin: false` mounts everything except this plugin (the
 *   control arm); `config` is the plugin's config; `answer` fabricates the
 *   executor's results; `sandboxMode` sets the executor's declared default
 *   (`null` for an executor that does not sandbox).
 * @returns the context, the executor, the sessions store, the notice sink and the captured log.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  const notices = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SandboxPolicyService, {
    mode: spec.deploymentMode ?? 'workspace-write',
    workspaceRoot: spec.workspaceRoot ?? '/deployment',
  })

  const shell = new StubShell(ctx, {
    sandboxMode: spec.sandboxMode === null ? undefined : spec.sandboxMode ?? 'workspace-write',
    ...spec.answer === undefined ? {} : { answer: spec.answer },
  })
  // Captured BEFORE the plugin mounts: the claim that the wrapper is an own
  // property on the instance is only meaningful against the class's own method.
  const prototypeExecute = Object.getPrototypeOf(shell).execute

  if (spec.plugin !== false) await ctx.plugin(plugin, spec.config ?? {})
  return {
    ctx,
    shell,
    prototypeExecute,
    sessions: ctx.sessions,
    sandboxPolicy: ctx.sandboxPolicy,
    notices,
    logged,
  }
}

/**
 * A stand-in agent whose seam is exactly what the plugin reads.
 *
 * The plugin's whole use of an agent is `currentInitiator()` returning it,
 * `agent.session` — handed unchanged to `SandboxPolicyService.resolve()`, so it
 * has to be the REAL session or the shipped projection fold rejects it — and
 * `agent.inject()` delivering the notice. The registry that hands the agent back
 * is the shipped one, so the inheritance is real even though the agent is not.
 * @param session - the live session this agent owns.
 * @param sink - the list notices are appended to.
 * @returns an agent-shaped object.
 */
export function fakeAgent(session, sink) {
  return {
    session,
    inject: (message) => { sink.push(message) },
  }
}

/**
 * A live session with a real workspace root and the shipped mode projection.
 * @param harness - a harness from {@link world}.
 * @param id - the session id.
 * @param cwd - the session's immutable workspace.
 * @returns the live session.
 */
export function session(harness, id, cwd = '/work') {
  return harness.sessions.create(SessionId(id), { meta: { cwd } })
}

/** Move a session's mode through the shipped write path. */
export { setSandboxMode }

/** The raw instance behind a cordis service view. */
export function rawOf(service) {
  return service[ORIGINAL] ?? service
}

/**
 * Make the shipped policy service unable to resolve a session.
 *
 * The shadow is written on the RAW instance, which is the same mechanism the
 * plugin's own wrapper uses — so a plugin that read the class method instead of
 * the instance would be measured here as unaffected, which is the point.
 * @param harness - a harness from {@link world}.
 * @param message - the failure the service reports.
 */
export function breakResolve(harness, message = 'the projection is unavailable') {
  Object.defineProperty(rawOf(harness.ctx.sandboxPolicy), 'resolve', {
    value: () => { throw new Error(message) },
    writable: true,
    configurable: true,
  })
}

/**
 * Run one shell request inside a session's initiator boundary, as the agent
 * loop does for every step it takes.
 * @param harness - a harness from {@link world}.
 * @param request - a request for the executor's own `resolve`.
 * @param agent - the agent whose boundary the call inherits.
 * @returns whatever the executor's `execute` resolves with.
 */
export function runInSession(harness, request, agent) {
  return harness.ctx.agents.withInitiator(agent, () => harness.ctx.shell.execute(harness.ctx.shell.resolve(request)))
}

/** Let the observer's detached continuation run to completion. */
export function settle() {
  return new Promise(resolve => { setTimeout(resolve, 20) })
}

/** The text of every notice delivered, in order. */
export function noticeTexts(notices) {
  return notices.map(message => message.content.map(block => block.text).join('\n'))
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
