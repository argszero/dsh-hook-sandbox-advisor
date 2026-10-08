/**
 * `@deepseek-ai/dsh-hook-protocol` executes command hooks through `ctx.shell`,
 * and the request it builds carries no sandbox policy. The shipped executors
 * are explicit that this is what the fallback is for — "tool calls pass the
 * calling session's resolved policy; direct calls fall back to deployment
 * policy" — so a hook is not merely executed by a different caller than a tool
 * call: it is confined by a different *policy*, and by the deployment's rather
 * than the session's.
 *
 * Two consequences follow from the same request, and both are silent:
 *
 * - the mode. A session running with a wider posture than the deployment's
 *   default gets a hook confined to the narrower one, and a hook that needs to
 *   spawn a child process or write outside the deployment root fails where the
 *   same command succeeds as a tool call.
 * - the root. `resolve()` answers `workspaceRoot` from the same expression pair
 *   as the mode, so an agentless call is granted a workspace it is not standing
 *   in: the hook's process cwd is the session's, while its grants are
 *   provisioned for the deployment's.
 *
 * This package names that condition. It does not change any policy: which of
 * "hooks inherit the session", "hooks run unconfined" or "hooks report their
 * confinement" is right is the maintainers' call, and a plugin that silently
 * widens a sandbox is the wrong shape for it.
 *
 * What it does do is attach to the one place every hook run passes through —
 * `ctx.shell.execute` — and report, against the session's own resolved mode,
 * what the run was actually confined to.
 *
 * @module @argszero/dsh-hook-sandbox-advisor
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecution, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'
import { isNarrower, rankOf } from './policy.ts'
import { isHookShaped } from './detect.ts'
import { boundExcerpt, renderHostNote, renderNotice } from './advice.ts'
import type { HookRunFacts } from './advice.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'hook-sandbox-advisor'

/**
 * The services this plugin reads. `shell` is the wrapped executor, `agents`
 * supplies the calling agent through its initiator boundary, and
 * `sandboxPolicy` answers both the deployment default and a session's own
 * resolved mode. All three are required: a missing one would leave the plugin
 * able to observe a run without being able to say what it should have been
 * confined to.
 */
export const inject = ['shell', 'agents', 'sandboxPolicy']

/** The source kind this plugin stamps on the notices it injects. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hook-sandbox-advisor': { kind: 'hook-sandbox-advisor' }
  }
}

export type { Config, Settings } from './config.ts'

/**
 * The decisions this plugin makes, exported so they can be read and tested
 * without mounting anything: which specs are hook-shaped, which mode is the
 * narrower one, and how each reportable condition is worded. The plugin's own
 * behaviour stays the `apply` export; these are the rules it applies.
 */
export { defaultConfig, normalizeConfig } from './config.ts'
export { isHookShaped } from './detect.ts'
export { isNarrower, rankOf } from './policy.ts'
export { boundExcerpt, renderHostNote, renderNotice } from './advice.ts'
export type { HookRunFacts } from './advice.ts'

/** The raw service instance behind a Cordis traceable view. */
const ORIGINAL = Symbol.for('cordis.original')

/** Marks the function this installation installed, so a later one can tell it apart. */
const WRAPPED = Symbol('hook-sandbox-advisor.wrapped')

/** One hook run, as the executor itself reported it. */
interface RunFacts extends HookRunFacts {
  readonly command: string
}

/**
 * Read the agent whose operation is inherited at this point, if any.
 *
 * The agent loop runs its whole `kick()` inside `agents.withInitiator`, so a
 * hook fired by an agent's step is inside that boundary and this answers the
 * agent whose session the hook serves. It throws once the registry is disposed,
 * which is not this plugin's failure to report.
 * @param ctx - the plugin context.
 * @returns the initiating agent, or `undefined` outside any boundary.
 */
function initiatingAgent(ctx: Context): Agent | undefined {
  try {
    return ctx.agents.currentInitiator()
  } catch {
    return undefined
  }
}

/**
 * The mode a run was actually confined to, from the run's own report.
 *
 * `ShellRunResult.sandbox` is the executor's own account of the mode the
 * command ran under, so it outranks anything this plugin could infer. It is
 * absent for an executor that does not sandbox at all — read from the executor
 * rather than assumed, because a deployment with no sandbox provider mounted
 * has no confinement to warn about and would only get noise from a plugin that
 * guessed.
 * @param execution - the settled foreground projection.
 * @param executorDefault - the executor's declared default mode, when it has one.
 * @returns the effective mode, or undefined when nothing was confined.
 */
function effectiveMode(
  execution: ShellExecution | undefined,
  executorDefault: SandboxMode | undefined,
): SandboxMode | undefined {
  const reported = execution?.sandbox?.mode
  if (reported !== undefined) return reported
  return executorDefault
}

/**
 * Install the observer and return its disposer.
 *
 * The wrapper is written as an **own property on the raw service instance**.
 * That is load-bearing rather than stylistic: `cordis` resolves a method by
 * walking the prototype chain from the raw instance on every read
 * (`getPropertyDescriptor`), so an own property shadows the class's method for
 * every consumer — including the hook bridge, which reaches the executor
 * through the same `ctx.shell` view it was injected with — and it leaves the
 * class itself untouched, so a second context mounting this plugin gets no
 * double wrapper.
 *
 * Reaching the instance through `ctx.shell` rather than through a captured
 * reference is what makes this robust: reading a *member* through the view
 * yields a fresh view each time (`ctx.shell.execute !== ctx.shell.execute`), so
 * there is no stable object to hold on to. `defineProperty` on the view does
 * forward to the instance — measured, and pinned as an equivalent mutant in
 * `scripts/inject-defects.mjs` — but the own property is what does the work
 * either way.
 * @param ctx - the plugin context.
 * @param settings - the normalized configuration.
 * @returns a disposer that restores the prototype method.
 */
function installShellObserver(ctx: Context, settings: Settings): () => void {
  const view = ctx.shell as unknown as Record<PropertyKey, unknown>
  const target = (view[ORIGINAL] ?? view) as { execute?: unknown }
  const original = target.execute
  if (typeof original !== 'function') {
    ctx.logger.warn('hook-sandbox-advisor: ctx.shell has no execute method; observation not installed')
    return () => {}
  }

  const notified = new Set<string>()
  /** Sessions whose mode could not be resolved, so the warn is not repeated. */
  const unresolved = new Set<string>()

  /** Report one run, once per session. */
  const report = (
    agent: Agent | undefined,
    facts: RunFacts,
    effective: SandboxMode,
    sessionMode: SandboxMode | undefined,
  ): void => {
    const reference = sessionMode ?? ctx.sandboxPolicy.defaultMode
    const narrowed = isNarrower(effective, reference)
    const denied = facts.denied === true
    if (!narrowed && !denied && !settings.reportEqual) return

    const sessionLabel = agent?.session.id
    if (agent === undefined || sessionLabel === undefined) {
      // No session to attach a durable notice to — `SessionStart` and the two
      // subagent points run without one, and the harness writes no `hook/*`
      // record for them either. The host log is the only channel left.
      ctx.logger.warn(renderHostNote(facts, effective, reference, narrowed, settings.hostNoteMaxChars))
      return
    }
    if (notified.has(sessionLabel) && !settings.repeat) return
    notified.add(sessionLabel)
    try {
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: renderNotice(facts, effective, reference, narrowed, settings.noticeMaxChars),
        }],
        source: { kind: 'hook-sandbox-advisor' },
      }))
    } catch (error: unknown) {
      // A refused injection must not become a second silent failure in a path
      // whose whole purpose is to make one visible.
      ctx.logger.warn(`hook-sandbox-advisor: could not deliver the hook notice: ${String(error)}`)
    }
  }

  /** Observe a settled hook run without perturbing the caller's own handling. */
  const observe = async (
    agent: Agent | undefined,
    spec: ShellExecSpec,
    run: Promise<ShellExecResult>,
    executorDefault: SandboxMode | undefined,
  ): Promise<void> => {
    let execution: ShellExecution | undefined
    try {
      execution = await run
    } catch {
      // Preparation rejected: no process was produced, so there is no mode to
      // compare. The bridge already turns this into a non-blocking hook error.
      return
    }
    let result: ShellRunResult | undefined
    try {
      result = await execution.result()
    } catch {
      return
    }
    const effective = effectiveMode(execution, executorDefault)
    if (effective === undefined) return

    const session = agent?.session
    let sessionMode: SandboxMode | undefined
    if (session !== undefined) {
      try {
        sessionMode = ctx.sandboxPolicy.resolve({ session }).mode
      } catch (error: unknown) {
        // Falling back to the deployment default keeps the comparison from
        // claiming a narrowing it cannot source — but doing it *silently* would
        // reproduce the very failure this plugin exists to name, so a session
        // that cannot be resolved is said out loud, once.
        sessionMode = undefined
        if (!unresolved.has(session.id)) {
          unresolved.add(session.id)
          ctx.logger.warn(
            `hook-sandbox-advisor: session ${session.id} has no resolvable sandbox mode (${String(error)});`
            + ' hook runs for it are compared against the deployment default',
          )
        }
      }
    }

    report(agent, {
      command: boundExcerpt(spec.command, settings.commandMaxChars),
      mode: effective,
      rank: rankOf(effective),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      denied: execution.sandbox?.denied === true,
      runnerFailed: execution.sandbox?.runnerFailed === true,
      stderrExcerpt: settings.includeStderr
        ? boundExcerpt(result.stderr.text, settings.stderrMaxChars)
        : undefined,
    }, effective, sessionMode)
  }

  const wrapped = async function (this: unknown, spec: ShellExecSpec): Promise<ShellExecution> {
    if (!isHookShaped(spec)) return await (original as (spec: ShellExecSpec) => Promise<ShellExecution>).call(target, spec)
    const agent = initiatingAgent(ctx)
    const executorDefault = ctx.shell.sandboxMode
    // The handle is returned unchanged: a background producer's identity and
    // its read paths must be exactly what the executor produced.
    const execution = await (original as (spec: ShellExecSpec) => Promise<ShellExecution>).call(target, spec)
    void observe(agent, spec, Promise.resolve(execution), executorDefault).catch(() => {})
    return execution
  }

  Object.defineProperty(wrapped, WRAPPED, { value: true })
  Object.defineProperty(target, 'execute', {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  })

  return () => {
    // Remove only this installation: a later wrapper that replaced ours is not
    // ours to undo, and deleting the own property is what restores the class's
    // method rather than a stale copy of it.
    if ((target as { execute?: unknown }).execute === wrapped) delete target.execute
  }
}

/** Local alias so the observation helpers read as results, not handles. */
type ShellRunResult = Awaited<ReturnType<ShellExecution['result']>>
type ShellExecResult = ShellExecution

/**
 * Mount the advisor.
 *
 * Both mount spellings are supported: `ctx.plugin(moduleNamespace)` has Cordis
 * fill the exported `Config` defaults, while `ctx.plugin({ name, inject, apply })`
 * passes `undefined` — so the default has to be here, not only in the schema.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return

  ctx.effect(
    () => installShellObserver(ctx, settings),
    'hook-sandbox-advisor: observe hook shell executions',
  )
}

export default { name, inject, apply, Config: defaultConfig }
