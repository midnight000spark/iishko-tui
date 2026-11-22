# Portable plugin verification — 2026-11-22

This records observed checks, not a Windows certification. The public repository
starts from a reviewed clean source snapshot; private development history is not
included. No real provider-configuration write, paid provider request or
neighboring Python modification was performed. The verified Linux plugin was
installed with user approval; old discovery entries were backed up outside the
plugins directory, with provider and CLI configuration hashes unchanged.

## Audit closure

| Finding | Disposition / regression evidence |
|---|---|
| F01: consent not bound to applied plan | Immutable in-memory prepared update, SHA identity and exact reconstruction under cooperative lock. `transaction.test.ts`, `controller.test.ts`. No shared `plan.json`. |
| F02: provider mismatch | Target comes from local account discovery and remains in preview, identity, re-discovery and apply. Manual Python commands removed. `discovery.test.ts`, `controller.test.ts`. |
| F03: concurrent operations | One synchronous owner across menu, dialogs, storage, network and apply. `controller.test.ts`. |
| F04: late effects after disposal | Abort propagated across awaited boundaries; guarded UI and actual storage callback. Controller lifecycle regressions plus isolated bundle smoke. |
| F05: Python plan-path disagreement | File-based Python plan reader, `planPath` and permissive `parsePlan` removed. Runtime uses typed in-memory planner. |
| F06: relative Python script resolution | Runner/subprocess output boundary removed. Narrow Windows ACL helper uses a fixed system executable; it is not a model-refresh CLI. |
| F07: empty known ranks fail open | Unknown and known-empty remain distinct through rank resolution, filtering and planning. `site.test.ts`, `refresh-plan.test.ts`. |
| F08: placeholder ranks lost | Placeholder entries retain published ranks; formatters show them without inventing measurements. `site.test.ts`, `catalog.test.ts`. |
| F09: malformed optional pricing breaks catalog | Optional sources isolate both fetch and parse; mandatory status still fails closed. `loader.test.ts`. |
| F10: account-switch stale fallback | No previous merged account catalog fallback after reload failure; loader owns bounded freshness. `catalog.test.ts`, `loader.test.ts`. |
| F11: cancellation outside fetch | Entry/cache/await/UI/storage guards; abort never becomes a stale-success response. Catalog, loader and controller regressions. |

## Improvements

- **I01:** dependency-injected controller and temporary-file transaction tests;
  execution smoke of the actual bundle with a mock host. Interactive host/Windows
  testing remains separate; loaded-module coverage is not full host coverage.
- **I02:** typed planner + immutable prepared identity replace the Python file
  protocol rather than adding another CLI/RPC layer.
- **I03:** account/path/rank/mode shown explicitly; absent metrics remain unknown.
  Raw config/system diagnostics are deliberately not exposed. Error messages
  remain conservative rather than introducing a general error framework.
- **I04:** pinned runtime dependencies, Bun 1.4.4 CI on Linux/Windows, release
  allowlist/integrity tests and Windows installer fixtures. Configured CI is not
  evidence of a successful remote run.
- **I05:** bounded documents, IDs, depth, numeric evidence and schema traversal;
  no paid API or subprocess log panel. Log batching/redaction for the deleted
  Python output panel is no longer applicable.
- **I06:** active account is persisted, initial account honored and local rank
  state updated. False Python path/parser contracts removed. No new lint stack.

## Observed checks

- Linux, Bun 1.4.4: `bun test` — **251 pass, 9 skip, 0 fail**, 851 assertions,
  17 files. The lower test count versus the previous 254-pass snapshot reflects
  removal of four obsolete Python helper tests and addition of an explicit-path
  regression, not newly skipped regressions.
- `bun run typecheck`, `git diff --check`, `bun run build`,
  `bun run verify:release` — passed.
- `bun run smoke:bundle` — passed in an isolated `bun test` child using official Bun module
  mocks. Actual copied release executed; three command IDs/slashes/keybinds,
  storage initialization, menu cancellation and inert commands after disposal
  checked. Network, config filesystem access and storage mutation forbidden.
  Static import scan excludes all unbundled packages except the host SDK.
  The test explicitly asserts that the filesystem builtin guard is effective;
  regular `bun run` does not enable that guard in Bun 1.4.4, so the harness uses
  the test runner inside its disposable child. Extracted ZIP rechecked this way.
- Live credential-free public smoke: actual OpenCode + fixed models.dev schema
  compiled and validated a synthetic V2 config. Public catalog contained 95
  entries with no warnings; add-only `t1` plan added 6 models, preserved the
  fixture entry, removed none; resulting config validated. **Zero config writes.**
- `bun audit --audit-level=high --json`: no high/critical advisory; two
  **moderate** advisory families (`glob`, `minimatch`) in the installed SDK/dev
  dependency graph. These packages are not included in the distributed bundle.
  The host SDK is external and supplied by OpenCode; this does not certify the
  host's own dependency graph. No unsupported transitive-major overrides added.

## Artifact evidence

- Transferable ZIP: `iishko-tui-0.1.0-windows.zip` in GitHub Releases.
- Each final release includes an external `.sha256`; use the checksum of that
  exact artifact, not an earlier development build's hash.
- `unzip -t` passed. Extracted ZIP passed the exact release inventory/hash
  verifier **and the executable bundle smoke**, not just a comparison against
  the original build directory. External `.sha256` accompanies the ZIP.

## Publication privacy gate

Gitleaks 8.30.1 (official archive checksum verified) scanned the original Git
history, prospective public source files and built release with full output
redaction: no secret findings. A separate privacy-pattern check found local
paths and ordinary author email in development history. That history is retained
privately; the public repository uses a clean snapshot and GitHub noreply author
identity instead. Scanner reports and development sessions are not published.
Automated scanners reduce risk; they do not prove the absence of every secret.

Independent pre-publication source review found no exploitable runtime security
blocker in the reviewed modules. It identified a CI packaging error: the Windows
Gitleaks asset is ZIP, not tar.gz. Archive selection/extraction was corrected
against the official release inventory before the first remote CI run. Qwen4
Max was attempted twice but the provider stream failed without a report; the
user approved a different independent reviewer, which completed the review.

## Remaining platform gate

Native Windows PowerShell 5.1 ACL/installer fixtures and interactive OpenCode
have **not run in this Linux environment**. Nine platform-specific tests are
skipped, not passed. Run the Windows CI job and `windows-smoke.md` before broad
distribution or calling the release Windows-tested. The ZIP can be produced
and checked here, but that is not evidence of Windows execution.

Lock regression tests use concurrent operations sharing the real fixture
filesystem. A separate Linux smoke with **two independent Bun processes** also
passed: first held the real lock during validation, second refused without
changing original bytes, first then committed once, retaining one backup and
no lock/temp residue. Only synthetic configuration under project `.tmp/` used.
Earlier independent source reviews covered the transaction/controller safety
boundaries; the final platform limitations are not waived by those reviews.

Filesystem locks coordinate cooperating instances only; a noncooperating editor
can race the final check/rename. No cross-platform atomic compare-and-swap,
power-loss durability or protection against a compromised same-user process is
claimed. Backups may contain credentials: keep them private and never attach
them to support reports.
