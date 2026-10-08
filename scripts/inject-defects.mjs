/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * the harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first; a
 * mutation that is never written to `lib/` is a mutation the suite cannot see. A
 * mutation that does not compile is reported separately as TYPEFAIL, because it
 * never reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped: one
 * distinction it exists to make, removed one line at a time. The arms are not
 * "does the test file import the module" — each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a claim the package makes
 * that nothing checks.
 *
 * ```sh
 * node scripts/inject-defects.mjs                     # every arm
 * node scripts/inject-defects.mjs --filter=detect     # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The second half of the detector. Without it, a bridge that later starts
    // resolving a policy keeps matching — and the plugin would report a hook
    // whose confinement is exactly right.
    name: 'detect: a request that carries a policy is still matched',
    file: 'src/detect.ts',
    edits: [['return spec.stdin !== undefined && spec.sandboxPolicy === undefined', 'return spec.stdin !== undefined']],
  },
  {
    name: 'detect: any request at all is matched',
    file: 'src/detect.ts',
    edits: [['return spec.stdin !== undefined && spec.sandboxPolicy === undefined', 'return true']],
  },
  {
    name: 'policy: equal modes count as a narrowing',
    file: 'src/policy.ts',
    edits: [['return rankOf(candidate) < rankOf(reference)', 'return rankOf(candidate) <= rankOf(reference)']],
  },
  {
    name: 'policy: the mode order is inverted',
    file: 'src/policy.ts',
    edits: [["  'danger-full-access': 2,\n  'workspace-write': 1,\n  'read-only': 0,",
      "  'danger-full-access': 0,\n  'workspace-write': 1,\n  'read-only': 2,"]],
  },
  {
    // The cap that keeps a hook firing on every tool call from filling the
    // transcript — which is what makes this plugin mountable at all.
    name: 'index: the notice repeats for every run in the session',
    file: 'src/index.ts',
    edits: [['if (notified.has(sessionLabel) && !settings.repeat) return', 'if (false) return']],
  },
  {
    name: 'index: a run at the session\'s own policy is reported anyway',
    file: 'src/index.ts',
    edits: [['if (!narrowed && !denied && !settings.reportEqual) return', 'if (false) return']],
  },
  {
    // A refusal at the deployment's own policy is a different fact from the
    // fallback, and it is the one that matters most to a user whose hooks fail.
    name: 'index: a refusal at the session\'s own policy is not reported',
    file: 'src/index.ts',
    edits: [['if (!narrowed && !denied && !settings.reportEqual) return', 'if (!narrowed && !settings.reportEqual) return']],
  },
  {
    // `SessionStart` and the subagent points have no session; a plugin that
    // silently drops them reports coverage it does not have.
    name: 'index: a run with no session is dropped silently',
    file: 'src/index.ts',
    edits: [['ctx.logger.warn(renderHostNote(facts, effective, reference, narrowed, settings.hostNoteMaxChars))', 'void renderHostNote(facts, effective, reference, narrowed, settings.hostNoteMaxChars)']],
  },
  {
    name: 'index: a session with no resolvable mode is not said out loud',
    file: 'src/index.ts',
    edits: [['          unresolved.add(session.id)', '          void session.id']],
  },
  {
    // The comparison would then be against a constant instead of the
    // deployment's own answer, so a narrow deployment would never be warned.
    name: 'index: the deployment default is not the fallback reference',
    file: 'src/index.ts',
    edits: [['const reference = sessionMode ?? ctx.sandboxPolicy.defaultMode', "const reference = sessionMode ?? 'read-only'"]],
  },
  {
    // The executor's declared default outranks the run's own report, so a run
    // that ended up narrower than the executor admits would go unreported.
    name: 'index: the run\'s own reported mode is ignored',
    file: 'src/index.ts',
    edits: [['  const reported = execution?.sandbox?.mode\n  if (reported !== undefined) return reported\n  return executorDefault',
      '  return executorDefault ?? execution?.sandbox?.mode']],
  },
  {
    // An executor that does not sandbox at all has no confinement to warn
    // about; assuming one would make this plugin pure noise on such a mount.
    name: 'index: an executor that does not sandbox is given a mode anyway',
    file: 'src/index.ts',
    edits: [['  const reported = execution?.sandbox?.mode\n  if (reported !== undefined) return reported\n  return executorDefault',
      "  return execution?.sandbox?.mode ?? 'workspace-write'"]],
  },
  {
    // The whole point is to make a silent failure visible; a failure in the
    // reporting path must not become a second silent one.
    name: 'index: a failed delivery is swallowed without a word',
    file: 'src/index.ts',
    edits: [['      ctx.logger.warn(`hook-sandbox-advisor: could not deliver the hook notice: ${String(error)}`)',
      '      void String(error)']],
  },
  {
    // Writing through the view lands on a fresh proxy rather than the instance,
    // so the bridge — which reads the executor through the same view — would
    // never reach the wrapper.
    name: 'index: the wrapper is written through the view instead of the instance',
    file: 'src/index.ts',
    equivalent: 'cordis\'s traceable view forwards defineProperty to the raw instance (measured: the own property lands on the instance either way), so the two spellings are the same installation — kept because the claim that they would differ is one this package used to make in prose',

    edits: [['const target = (view[ORIGINAL] ?? view) as { execute?: unknown }', 'const target = view as { execute?: unknown }']],
  },
  {
    name: 'index: `off` mode installs the observer anyway',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'off') return\n", '']],
  },
  {
    name: 'index: a tool call is observed like a hook',
    file: 'src/index.ts',
    edits: [['if (!isHookShaped(spec)) return await (original as (spec: ShellExecSpec) => Promise<ShellExecution>).call(target, spec)',
      'if (false) return await (original as (spec: ShellExecSpec) => Promise<ShellExecution>).call(target, spec)']],
  },
  {
    name: 'index: the stderr excerpt is not bounded',
    file: 'src/index.ts',
    edits: [['boundExcerpt(result.stderr.text, settings.stderrMaxChars)', 'result.stderr.text']],
  },
  {
    name: 'index: the command line is not bounded',
    file: 'src/index.ts',
    edits: [['command: boundExcerpt(spec.command, settings.commandMaxChars),', 'command: spec.command,']],
  },
  {
    name: 'config: an unknown mode is accepted as written',
    file: 'src/config.ts',
    edits: [["mode: config.mode === 'off' ? 'off' : 'notice',", "mode: config.mode ?? 'notice',"]],
  },
  {
    name: 'config: a bound that is not a positive integer is kept',
    file: 'src/config.ts',
    edits: [['return typeof value === \'number\' && Number.isInteger(value) && value > 0 ? value : fallback',
      'return value ?? fallback']],
  },
  {
    name: 'config: a switch that is not a boolean is kept',
    file: 'src/config.ts',
    edits: [['return typeof value === \'boolean\' ? value : fallback', 'return value ?? fallback']],
  },
  {
    name: 'config: the host note loses its own, smaller bound',
    file: 'src/config.ts',
    edits: [['hostNoteMaxChars: positiveInteger(config.hostNoteMaxChars, defaultConfig.hostNoteMaxChars),',
      'hostNoteMaxChars: positiveInteger(config.hostNoteMaxChars, Number.MAX_SAFE_INTEGER),']],
  },
  {
    name: 'advice: the whole notice is not bounded',
    file: 'src/advice.ts',
    edits: [["return boundExcerpt([body].join('\\n'), maxChars)", "return [body].join('\\n')"]],
  },
  {
    name: 'advice: a cut is not marked',
    file: 'src/advice.ts',
    edits: [['`${trimmed.slice(0, maxChars - 1)}…`', 'trimmed.slice(0, maxChars)']],
  },
  {
    name: 'advice: the excerpt is not trimmed',
    file: 'src/advice.ts',
    edits: [['const trimmed = text.trim()', 'const trimmed = text']],
  },
  {
    name: 'advice: the session\'s own mode is left out of the notice',
    file: 'src/advice.ts',
    edits: [["    line('this session resolves to', `\\`${reference}\\``),\n", '']],
  },
  {
    // The header and the explanation are the whole value of the notice: a
    // reader must be able to tell a fallback from a refusal from an
    // operator-requested equal-mode report.
    name: 'advice: a refusal is rendered as a narrowing',
    file: 'src/advice.ts',
    edits: [["const reason: 'narrowed' | 'denied' | 'equal' = narrowed ? 'narrowed' : facts.denied ? 'denied' : 'equal'",
      "const reason: 'narrowed' | 'denied' | 'equal' = narrowed ? 'narrowed' : 'equal'"]],
  },
  {
    name: 'advice: an empty stderr excerpt is printed as an empty line',
    file: 'src/advice.ts',
    edits: [["    line('stderr', facts.stderrExcerpt === undefined || facts.stderrExcerpt.length === 0\n      ? ''\n      : `\\`${facts.stderrExcerpt}\\``),",
      "    line('stderr', `\\`${facts.stderrExcerpt}\\``),"]],
  },
  {
    name: 'advice: the host note never mentions the deployment default',
    file: 'src/advice.ts',
    edits: [["    + (narrowed ? `, narrower than the deployment default ${reference}` : '')", "    + ''"]],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a guard from a path the
 * plugin observes can leave a rejected promise unhandled, and a mutant that
 * never terminates is a mutant the suite cannot report on. It is killed here
 * and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
