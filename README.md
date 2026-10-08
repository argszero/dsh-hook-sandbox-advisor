# @argszero/dsh-hook-sandbox-advisor

Names the condition behind a hook that fails silently on a confined deployment.

A **hook** is a command the Claude Code and Codex bridges run on your behalf.
This plugin reports, once per session, what each hook run was actually confined
to — compared against the mode the session that fired it resolves to.

It changes no policy. Which of *"hooks inherit the session"*, *"hooks run
unconfined"* or *"hooks report their confinement"* is correct is a core
decision; a plugin that silently widened a sandbox would be the wrong shape for
it. This one only reports.

## The problem

`@deepseek-ai/dsh-hook-protocol` executes command hooks through `ctx.shell`, and
the request its runner builds carries no `sandboxPolicy`
(`packages/hooks/hook-protocol/src/runner.ts:77-84`):

```ts
const request = {
  command: hook.command,
  timeoutMs,
  stdin,
  signal: options.signal,
  ...options.cwd !== undefined ? { workdir: options.cwd } : {},
  ...options.env !== undefined ? { env: options.env } : {},
}
```

The executors document exactly what that omission selects — *"Tool calls pass the
calling session's resolved policy; direct calls fall back to deployment
policy"* (`packages/shell/bash-sandbox/src/index.ts:41-42`,
`packages/shell/pwsh-sandbox/src/index.ts:46-47`).

So a hook is not merely executed by a different caller than a tool call: it is
confined by a different **policy**, and by the deployment's rather than the
session's. The deployment default is `workspace-write`
(`packages/bundle/base/cordis.patch.yml:232`, or whatever `DSH_PERMISSION_MODE`
sets).

Two consequences follow from the same request, and both are silent:

- **the mode.** A session running wider than the deployment default gets a hook
  confined to the narrower one. A hook that needs to spawn a child process, or
  to write outside the deployment's workspace root, fails here — where the same
  command succeeds as a tool call. The harness keeps only the hook's exit code,
  so the failure reads like any other non-zero exit.
- **the points with no record at all.** `SessionStart`, `SubagentStart` and
  `SubagentStop` fire outside any turn, so no `hook/invoked` or `hook/result` is
  written for them and there is no session to notify.

## What it does

It attaches to the one place every hook run passes through — `ctx.shell.execute`
— and reports what the run was confined to:

| condition | what you get |
|---|---|
| the run was confined **more tightly** than its session | one durable notice in that session, naming both modes, the outcome, and a bounded stderr excerpt |
| the run was **refused** at its session's own policy | the same notice — a refusal is a different fact from a fallback, and the notice says which |
| the modes **agree** and nothing was refused | nothing, unless `reportEqual` asks for it |
| there was **no session** (`SessionStart` and the subagent points) | a bounded single-line note in the host log, saying that no session and no `hook/*` record exists for it |

Notices are stamped with the source kind `hook-sandbox-advisor`, so they are
distinguishable from anything else in the transcript, and they are deduplicated
per session by default — the condition is a property of the *session's posture*,
not of the individual run.

### What it will not tell you

Which operation was refused, or why. The shell result carries the mode, the
denial flag and the streams, and no more. Treat the notice as the condition to
investigate, not as the cause.

## Install

```sh
npm install --save-dev @argszero/dsh-hook-sandbox-advisor
```

Mount it with the bundle patch this package ships, by adding
`@argszero/dsh-hook-sandbox-advisor` to your profile's dependencies and letting
`dsh.bundle.patch` do the rest — or by hand:

```yaml
- insert:
    - id: hook-sandbox-advisor
      name: '@argszero/dsh-hook-sandbox-advisor'
```

## Configuration

```yaml
- insert:
    - id: hook-sandbox-advisor
      name: '@argszero/dsh-hook-sandbox-advisor'
      config:
        reportEqual: false
```

| key | default | meaning |
|---|---|---|
| `mode` | `notice` | `notice` reports; `off` installs nothing at all, for pinpointing whether this plugin is responsible for any behaviour |
| `reportEqual` | `false` | report a run whose confinement equals its session's. Off by default: at equal modes the fallback costs the hook nothing, and reporting it turns every hook in a default deployment into noise. A refused run is reported either way |
| `repeat` | `false` | report the same session more than once. Off by default, so a hook that fires on every tool call cannot fill the transcript |
| `includeStderr` | `true` | include a bounded excerpt of the hook's stderr |
| `commandMaxChars` | `160` | bound for the hook command line quoted into the notice |
| `stderrMaxChars` | `400` | bound for the stderr excerpt |
| `noticeMaxChars` | `2000` | bound for the whole session notice |
| `hostNoteMaxChars` | `500` | bound for the host-log note used when a run has no session |

Every bound exists because the value it bounds is caller text — a hook command
line, a hook's stderr, and the notice assembled from both. A notice that can
grow without a bound is a durable record that can grow without one. A value that
is not a positive integer (or not a boolean, for the switches) falls back to its
default rather than propagating.

## Compatibility

Verified against these prerelease lines of `@deepseek-ai/dsh-*`, by pinning
**every** harness package to one line and running this package's suite against
it (`pnpm test:probe-lines`, development-only and not published):

- `0.1.7-alpha.1`
- `0.1.7-rc.2`
- `0.2.0-rc.2`

The peer range that describes exactly those lines is:

```
>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.0
```

Lines outside that range are not claimed. This package is pre-stable along with
the harness it plugs into; the API is used through the shipped services
(`ctx.shell`, `ctx.agents`, `ctx.sandboxPolicy`) and through `ShellExecSpec`,
whose `stdin`/`sandboxPolicy` members it reads.

## Tests

```sh
npm test              # behaviour, the gap, and the packaging guard
npm run test:inject   # mutate the source; every arm must be caught
npm run test:probe-lines
```

`test/gap.spec.mjs` runs the **shipped** `@deepseek-ai/dsh-hook-protocol`
runner, so the request this plugin matches is the one the bridges actually
build. If a bridge ever starts supplying a `sandboxPolicy`, that suite goes red
before any user is surprised — and this plugin goes quiet on its own.

## License

MIT
