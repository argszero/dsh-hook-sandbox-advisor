/**
 * What the advisor says, in the two places it can say it.
 *
 * Both renderers are pure and take everything they need, so the conditions that
 * decide *whether* to report stay in the entry and the wording stays testable
 * without a running harness. Both are also deliberately explicit about the edge
 * of what was observed: this plugin can name the confinement and the outcome,
 * and it cannot name which operation a sandbox refused — nothing in the shell
 * result carries that.
 *
 * @module @argszero/dsh-hook-sandbox-advisor/advice
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** What one hook run reported about itself. */
export interface HookRunFacts {
  /** The hook's command line, already bounded. */
  readonly command: string
  /** The mode the executor reports the run was confined to. */
  readonly mode: SandboxMode
  /** The permissiveness rank of {@link mode}. */
  readonly rank: number
  /** The process exit code, or null when it died from a signal. */
  readonly exitCode: number | null
  /** The terminating signal, when there was one. */
  readonly signal: string | null
  /** The executor's own deadline was the first cause to cut the run short. */
  readonly timedOut: boolean
  /** The caller's signal was the first cause to kill the run. */
  readonly aborted: boolean
  /** The sandbox refused a file operation during this run. */
  readonly denied: boolean
  /** The confined runner failed before the command could run. */
  readonly runnerFailed: boolean
  /** A bounded excerpt of the hook's stderr, when the configuration keeps one. */
  readonly stderrExcerpt: string | undefined
}

/**
 * Cut a string to a bound, marking the cut.
 * @param text - the raw text.
 * @param maxChars - the inclusive bound; non-positive keeps nothing.
 * @returns the text, unchanged when it fits.
 */
export function boundExcerpt(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`
}

/** One `- label: value` line, omitted when the value carries nothing. */
function line(label: string, value: string): string {
  return value.length === 0 ? '' : `- ${label}: ${value}`
}

/** The outcome half of a run, as one sentence fragment. */
function outcomeOf(facts: HookRunFacts): string {
  const parts: string[] = []
  if (facts.denied) parts.push('the sandbox refused a file operation')
  if (facts.runnerFailed) parts.push('the sandbox runner failed')
  if (facts.timedOut) parts.push('the executor deadline expired')
  if (facts.aborted) parts.push('the caller aborted it')
  if (facts.signal !== null) parts.push(`killed by ${facts.signal}`)
  else if (facts.exitCode !== null && facts.exitCode !== 0) parts.push(`exited ${facts.exitCode}`)
  if (parts.length === 0) return facts.exitCode === 0 ? 'completed normally' : 'no exit code was reported'
  return parts.join('; ')
}

/**
 * Render the durable notice a session gets.
 *
 * The first paragraph is the whole point, and it names WHICH of the three
 * reportable conditions this is:
 *
 * - `narrowed` — the run was confined more tightly than its session. This is
 *   the condition the package exists for, and the paragraph states why: the
 *   request carried no policy, so the deployment default applied.
 * - `denied` — the sandbox refused the run at the session's own policy. Not a
 *   fallback defect, and the paragraph says so rather than implying one.
 * - `equal` — the modes agreed and nothing was refused; the notice exists only
 *   because the deployment asked for equal-mode runs to be reported.
 *
 * A reader who has never seen the hook protocol must be able to tell the three
 * apart from the text alone, so the header, the explanation and the closing
 * advice are all chosen by the same reason.
 * @param facts - what the run reported.
 * @param effective - the mode the run was actually confined to.
 * @param reference - the mode the run's session resolves to (or the deployment default).
 * @param narrowed - whether {@link effective} confines strictly more than {@link reference}.
 * @param maxChars - the notice's inclusive character bound.
 * @returns the notice text.
 */
export function renderNotice(
  facts: HookRunFacts,
  effective: SandboxMode,
  reference: SandboxMode,
  narrowed: boolean,
  maxChars: number,
): string {
  const observation = [
    line('hook command', `\`${facts.command}\``),
    line('confined to', `\`${effective}\``),
    line('this session resolves to', `\`${reference}\``),
    line('outcome', outcomeOf(facts)),
    line('stderr', facts.stderrExcerpt === undefined || facts.stderrExcerpt.length === 0
      ? ''
      : `\`${facts.stderrExcerpt}\``),
  ].filter(entry => entry.length > 0).join('\n')

  const reason: 'narrowed' | 'denied' | 'equal' = narrowed ? 'narrowed' : facts.denied ? 'denied' : 'equal'
  const header = {
    narrowed: 'A hook ran under a narrower file policy than the session that fired it.',
    denied: 'A hook was refused by the sandbox.',
    equal: 'A hook ran confined, at the same policy as the session that fired it.',
  }[reason]

  const explanation = {
    narrowed: 'The harness builds a hook\'s shell request without a sandbox policy'
      + ' (`packages/hooks/hook-protocol/src/runner.ts`), so the executor applies the'
      + ' **deployment** default instead of the session\'s. A hook that needs to spawn a'
      + ' child process, or to write outside the deployment\'s workspace root, can fail'
      + ' here where the same command succeeds as a tool call.',
    denied: 'The confinement reported above is the session\'s own, so this is the sandbox'
      + ' doing its job rather than a policy the hook was handed by mistake — reported'
      + ' because the exit code the harness keeps for a hook reads the same as any other'
      + ' failing command.',
    equal: 'The confinement reported above is the session\'s own, so nothing was taken'
      + ' away from this hook — reported because this deployment asked for equal-mode runs'
      + ' to be reported (`reportEqual`).',
  }[reason]

  const advice = reason === 'narrowed'
    ? 'To stop a hook from meeting a narrower policy than its session, run it from a session'
      + ' whose mode is already as confined as the hook tolerates, or widen the deployment'
      + ' default: `DSH_PERMISSION_MODE` sets it for the whole deployment (and, at'
      + ' `danger-full-access`, also sets the deployment approval policy to `never`). This'
      + ' plugin changes no policy.'
    : 'This plugin changes no policy; it only reports. Set `repeat` to hear about more than'
      + ' the first run in a session, or `reportEqual: false` to hear only about runs that'
      + ' were actually refused at their own policy.'

  const body = [
    header,
    '',
    observation,
    '',
    explanation,
    '',
    'What this notice does not say: which operation was refused, or why. The shell result'
    + ' carries the mode, the denial flag and the streams, and no more — so treat the line'
    + ' above as the condition to investigate, not as the cause.',
    '',
    advice,
  ].join('\n')

  return boundExcerpt([body].join('\n'), maxChars)
}

/**
 * Render the one-line note for a run with no session to attach a notice to.
 *
 * `SessionStart`, `SubagentStart` and `SubagentStop` fire outside any turn, so
 * the harness writes no durable `hook/invoked` or `hook/result` for them — and
 * a run with no session has nowhere to inject one either. Saying so in the host
 * log is the honest coverage, rather than a notice that pretends to cover a
 * point it cannot see.
 * @param facts - what the run reported.
 * @param effective - the mode the run was actually confined to.
 * @param reference - the mode to compare against (the deployment default here).
 * @param narrowed - whether {@link effective} confines strictly more than {@link reference}.
 * @param maxChars - the note's inclusive character bound.
 * @returns the note text, without a trailing newline.
 */
export function renderHostNote(
  facts: HookRunFacts,
  effective: SandboxMode,
  reference: SandboxMode,
  narrowed: boolean,
  maxChars: number,
): string {
  return boundExcerpt(
    `a hook with no session ran confined to ${effective}`
    + (narrowed ? `, narrower than the deployment default ${reference}` : '')
    + ` (${outcomeOf(facts)}); no session to notify and no hook/* record exists for this`
    + ` point — command: ${facts.command}`,
    maxChars,
  )
}
