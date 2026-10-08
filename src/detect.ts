/**
 * The signature that identifies a hook run.
 *
 * Two facts, both read off the resolved spec, both true of every hook the
 * shipped bridges run and of nothing else this harness does:
 *
 * - `stdin` is set. The harness documents exactly one producer for it: "set by
 *   in-process plugins (e.g. the hooks bridges, which write a hook command's
 *   JSON payload to its stdin)". `@deepseek-ai/dsh-hook-protocol`'s runner is
 *   the only caller in the tree that sets it, and the model-facing bash tool
 *   deliberately does not expose it as a parameter.
 * - `sandboxPolicy` is absent. Every tool layer resolves a policy per call and
 *   passes it; the hook request never carries one.
 *
 * Reading the request rather than the call stack is what makes this survive
 * bundling: a released runtime that inlines the hook protocol would leave no
 * `dsh-hook-protocol` frame to match, but it cannot inline the request object.
 *
 * The second half is also the reason this plugin goes quiet on its own once the
 * condition is fixed: a bridge that starts supplying a policy stops matching
 * here, with no change to this package.
 *
 * @module @argszero/dsh-hook-sandbox-advisor/detect
 */

import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'

/**
 * Whether one resolved shell spec is a hook invocation.
 * @param spec - a spec produced by {@link ShellExecSpec}, before execution.
 * @returns true when the request is the hook bridge's shape.
 */
export function isHookShaped(spec: ShellExecSpec): boolean {
  return spec.stdin !== undefined && spec.sandboxPolicy === undefined
}
