# Windows/OpenCode release smoke checklist

Status: checklist, **not evidence of an executed Windows or live OpenCode test**.
Record date, Windows architecture/version, OpenCode version, plugin version,
ZIP SHA-256, CI run URL and actual outcome before calling a release Windows-tested.
Never attach real configuration, backup files or credentials to a report.

## Automated CI (isolated)

- [ ] Linux and Windows jobs: frozen install, vulnerability scan, typecheck, tests.
- [ ] Bundle verification: exact file allowlist, hashes, host externals, no maps,
      absolute developer paths or build-secret sentinel.
- [ ] Windows PowerShell **5.1** fixture install of the actual built release.
- [ ] Windows ACL transaction fixture: deliberately broad parent directory ACL,
      source owned by the current user with a restricted owner-only DACL;
      backup and replacement retain that owner and do not gain broader rights.
- [ ] Replacement consent, backup outside plugins, unknown-file refusal,
      corrupt payload refusal and junction refusal all pass.
- [ ] ZIP created with Compress-Archive; extracted ZIP passes verifier.

CI fixtures use an explicit temporary `-ConfigHome` and a fake `opencode --version`.
They do not prove that a real host loads or renders the bundled plugin.
Automation needs `-NonInteractive -ConfigHome <absolute-fixture-path>`;
replacement also needs `-Replace`. No bypass-version-check flag exists.

## Interactive Windows (explicitly authorized test installation only)

Use a disposable Windows user/config root with synthetic provider config, never
a recipient's real credentials. Do not invoke paid provider endpoints.

- [ ] Ordinary Windows user, no Python/WSL/Bun/Node CLI installed; stable OpenCode
      **major 2**, version >= 2.2.5 already present. Future major 3 is not accepted
      automatically. Try a path with spaces and a non-ASCII username.
- [ ] Extract ZIP, double-click install.cmd; explanation and YES prompt visible.
      Decline first: no plugin/config write. Re-run and approve.
- [ ] Destination matches XDG_CONFIG_HOME, or USERPROFILE/.config fallback.
      No admin prompt; no system/user execution policy change; no download/service start.
- [ ] Managed execution policy refusal explains contacting admin rather than disabling it.
- [ ] OpenCode discovers exactly one TUI-only package; /reload works without
      missing imports, duplicate Solid runtime or JSX errors.
- [ ] Ctrl+P finds plugin; catalog, filters, account/rank selection and Escape work.
- [ ] Installer and runtime refuse unsupported old, unknown, preview and other-major
      OpenCode versions clearly, including major 3. Missing PATH warns at install,
      without claiming that compatible OpenCode has been installed.
- [ ] Temporary synthetic JSONC: preview shows local path/provider/rank and reasons.
      Cancel leaves exact bytes unchanged; add-only never removes models.
- [ ] Full mode removes only hard-down models satisfying all documented thresholds;
      unlisted models remain and no unlisted-pruning choice is offered.
- [ ] Approved fixture write changes only chosen provider.models; BOM/CRLF/comments
      outside the span and existing metadata survive. Backup path is shown.
- [ ] ACL helper uses the system Windows PowerShell executable, fixed encoded code
      and JSON stdin for paths/descriptors; no shell, PATH lookup, profile loading,
      policy bypass, elevation, Python invocation or paid provider calls.
- [ ] In a disposable synthetic fixture only, grant broad inherited read access on
      its parent but restrict source DACL to its current-user owner. Verify backup
      and temporary file ACL protection occurs **before any config bytes are written**;
      both have the same owner and no broader access than the source. The final
      replacement also retains those protected rights, with no broad inherited ACEs.
      Use transaction test instrumentation for pre-write/temp assertions, not real
      credentials or a live user's config. Record assertions actually observed.
- [ ] Source ACL change, unsupported ACL/owner, denied ACL operation or unavailable
      helper refuses the transaction without replacing the original. Managed policy
      remains unchanged; do not elevate or disable policy to make a test pass.
- [ ] Change config after preview: commit refuses. Duplicate/ambiguous config refuses.
- [ ] Disconnect network during loading/schema fetch: safe error, no write.
- [ ] /reload/dispose while loading: no stale confirmation or late write.
- [ ] Remote-server connection still labels and edits only the explicit LOCAL fixture.
- [ ] Reinstall: prior plugin backed up outside discovery; no duplicate entries.
      Locked-file failure preserves/restores original; record manual rollback behavior.
- [ ] Restore plugin and config backups using README procedure; remove only fixture
      installation and fixture artifacts after retaining a redacted result report.

Do not mark unchecked items as passed. Tests do not promise recovery from power
loss, malicious concurrent same-user filesystem changes, or a compromised ZIP sender.
