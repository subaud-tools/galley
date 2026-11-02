# Release setup

`galley setup-bundle --version X.Y.Z --out galley_setup.tar.gz` builds the release integration archive without installing anything or starting a page server. Releases publish it and its checksum beside the binary through tools-actions 0.13.1.

Kempt **0.13.0 or newer** is required to consume the schema-2 integration. Add `setup = true` to the existing `galley` download declaration. The bundle contributes only `packages.integration`: the embedded skill for the shared default Claude Code, Codex and pi targets, the subaud-tools Claude marketplace/plugin, and the existing pi channel registration. It does not manage pi's packages list or a login service. Pages still start on demand.

The skill bytes are the same ones `galley skills install` installs and the channel refreshes. `internal/cli/setup.toml` owns the selected registrations; skill destinations come from tools-common's `skills.UserTargets`, not a second harness list. Unrelated settings are preserved; only the explicitly named retired registrations are removed.

## Verification

`KEMPT_TEST_BIN=/path/to/released/kempt go test ./internal/cli -run TestSetup` checks archive generation and registration convergence in temporary HOME/XDG directories. The public-engine test applies only the selected JSON merges twice; verified-download binding of managed skill files is checked when the release is prepared. Without `KEMPT_TEST_BIN`, that integration test is explicitly skipped.
