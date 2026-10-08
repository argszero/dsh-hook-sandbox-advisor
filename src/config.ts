/**
 * Configuration, normalized once at mount.
 *
 * Every bound here exists because the value it bounds is caller text: a hook
 * command line, a hook's stderr, and the notice assembled from both. A notice
 * that can grow without a bound is a durable record that can grow without one,
 * so the caps are part of the contract rather than tuning knobs.
 *
 * @module @argszero/dsh-hook-sandbox-advisor/config
 */

/** What the advisor does with a run it considers reportable. */
export type AdvisorMode = 'notice' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /**
   * `notice` (default) reports to the session and, for runs with no session,
   * to the host log. `off` installs nothing at all — useful for pinpointing
   * whether this plugin is responsible for any behaviour at all.
   */
  readonly mode?: AdvisorMode
  /**
   * Report a run whose confinement equals its session's. Off by default: at
   * equal modes the fallback costs the hook nothing, and reporting it turns
   * every hook in a default deployment into noise. A sandbox that *refused* the
   * run is reported either way.
   */
  readonly reportEqual?: boolean
  /**
   * Report the same session more than once. Off by default: the condition is a
   * property of the session's posture, not of the individual run, so one notice
   * carries the whole finding and a hook that fires on every tool call does not
   * fill the transcript.
   */
  readonly repeat?: boolean
  /** Include a bounded excerpt of the hook's stderr in the notice. */
  readonly includeStderr?: boolean
  /** Inclusive bound for the hook command line quoted into the notice. */
  readonly commandMaxChars?: number
  /** Inclusive bound for the stderr excerpt. */
  readonly stderrMaxChars?: number
  /** Inclusive bound for the whole session notice. */
  readonly noticeMaxChars?: number
  /** Inclusive bound for the host-log note used when a run has no session. */
  readonly hostNoteMaxChars?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: AdvisorMode
  readonly reportEqual: boolean
  readonly repeat: boolean
  readonly includeStderr: boolean
  readonly commandMaxChars: number
  readonly stderrMaxChars: number
  readonly noticeMaxChars: number
  readonly hostNoteMaxChars: number
}

/** The reference defaults, also exported as the plugin's `Config`. */
export const defaultConfig: Required<Config> = {
  mode: 'notice',
  reportEqual: false,
  repeat: false,
  includeStderr: true,
  commandMaxChars: 160,
  stderrMaxChars: 400,
  noticeMaxChars: 2000,
  hostNoteMaxChars: 500,
}

/**
 * Read a positive integer, falling back when the value is absent or unusable.
 *
 * A caller-supplied bound is caller text like any other: `0` would silently
 * disable the thing it bounds and `NaN` would make every comparison false, so
 * both fall back rather than propagate.
 * @param value - the configured value.
 * @param fallback - the default to use when the value is not a positive integer.
 * @returns the value or the fallback.
 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** Read a boolean, falling back for anything that is not one. */
function boolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Resolve a user configuration into the settings the plugin runs with.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  return {
    mode: config.mode === 'off' ? 'off' : 'notice',
    reportEqual: boolean(config.reportEqual, defaultConfig.reportEqual),
    repeat: boolean(config.repeat, defaultConfig.repeat),
    includeStderr: boolean(config.includeStderr, defaultConfig.includeStderr),
    commandMaxChars: positiveInteger(config.commandMaxChars, defaultConfig.commandMaxChars),
    stderrMaxChars: positiveInteger(config.stderrMaxChars, defaultConfig.stderrMaxChars),
    noticeMaxChars: positiveInteger(config.noticeMaxChars, defaultConfig.noticeMaxChars),
    hostNoteMaxChars: positiveInteger(config.hostNoteMaxChars, defaultConfig.hostNoteMaxChars),
  }
}
