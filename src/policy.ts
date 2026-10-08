/**
 * Ordering, and nothing else: the one relation this plugin needs is "was this
 * run confined more tightly than the session it serves". Which of the three
 * modes is wider is a property of the harness's own vocabulary, so it lives in
 * one table here rather than in a comparison spelled out at each use site.
 *
 * @module @argszero/dsh-hook-sandbox-advisor/policy
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * Most to least permissive. The numbers are ranks, not a scale: only their
 * order is meaningful, and nothing here does arithmetic on them.
 */
const RANKS: Record<SandboxMode, number> = {
  'danger-full-access': 2,
  'workspace-write': 1,
  'read-only': 0,
}

/**
 * The permissiveness rank of one mode.
 * @param mode - a harness sandbox mode.
 * @returns 0 for `read-only`, 1 for `workspace-write`, 2 for `danger-full-access`.
 */
export function rankOf(mode: SandboxMode): number {
  return RANKS[mode]
}

/**
 * Whether `candidate` confines more than `reference`.
 *
 * Strict: two runs at the same mode are not narrowed by each other, which is
 * what keeps the notice off a deployment whose sessions are already at the
 * default posture — the fallback costs those users nothing.
 * @param candidate - the mode actually applied to a run.
 * @param reference - the mode the run's own session resolves to.
 * @returns true when the candidate is strictly narrower.
 */
export function isNarrower(candidate: SandboxMode, reference: SandboxMode): boolean {
  return rankOf(candidate) < rankOf(reference)
}
