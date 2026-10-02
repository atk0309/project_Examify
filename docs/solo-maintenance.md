# Look after your Examify installation

For the Windows/Linux solo preview. For household servers, use
[operations](operations.md) instead. [Back to first practice](solo-installation.md).

## Find your files

Unless you chose another folder, the whole installation is here:

- Windows: `%LOCALAPPDATA%\Examify` (paste this into File Explorer)
- Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/examify`

`installation.json` selects the current application and study state. On a fresh
install, `data/` holds your database, materials and question banks, and `config/`
holds private settings. After an upgrade, the current `data/` and `config/` can
live inside the `states/` folder named by that file. Do not edit the pointer or
copy individual generations to repair an installation.

## Back up or recover a solo installation

Stop Examify and copy the **whole installation folder** to a private location.
This retains the installation pointer, matching application/runtime, all state
generations, configuration and recovery metadata. After an upgrade, `data` and
`config` at the root can be an older snapshot: copying only those folders can
miss current work. Keep backup copies private; they include authentication
secrets and saved provider keys. Never publish or share them.

To recover, retain the damaged installation unchanged, restore the complete
known-good backup into a separate private folder, and launch its `Examify` or
`Examify.cmd` entrypoint. Do not overlay old app files onto a newer database or
manually change just the version field. Recovery to a pre-upgrade backup loses
changes made after that snapshot; preserve the newer installation for possible
recovery of that work. Never run two copies against the same data directory.

The retained previous generation and its matching release provide a recovery
source, not a second automatically active installation. The previous pointer is
recorded in `installation.json`, and candidate `backup-source.json` records the
source snapshot’s hashes. Advanced selective recovery requires keeping that
matched pair together in a separate folder; there is no one-click rollback or
automatic old-generation cleanup in this release.

The `.examify-operations` databases are coordination files, outside study state.
Do not remove them while an operation is active. Stale process markers after a
crash do not require manual deletion. The household `examify:data` backup command
does not capture this complete solo layout; use the full-folder backup above.

## Remove the app without losing your work

There is no uninstall command in this preview. Stop Examify with Ctrl+C first.
Keep a private copy of the **whole installation folder**, then remove its
original folder and shortcut. Keep that backup if you want to use your questions
and progress again; removing the original folder also removes the data inside it.

- Windows: remove **Examify** from the Start menu. Its shortcut is `Examify.lnk`
  in the folder opened by `shell:programs` in File Explorer
- Linux: remove `examify-solo.desktop` from
  `${XDG_DATA_HOME:-$HOME/.local/share}/applications`

Removing the shortcut alone only hides the app. To permanently remove study data
and saved provider keys too, also delete your installation copies and backups.
Emptying the Recycle Bin or Trash is irreversible through normal recovery. This
is not a secure-erasure guarantee, and deleting a saved key does not revoke it
at its provider.

## Upgrade safely

Run the new version-pinned installer against the same installation folder, with
Examify stopped. Legacy preview installations cannot upgrade in place: keep
them intact and use a separate empty folder. A same-version repair does not
convert that old format. There is no automatic download or silent downgrade. CI preview
labels and prereleases are not ordered as upgrade versions. The first public
upgrade-capable package must have a version never used by a legacy preview.

An upgrade or upgrade-capable same-version repair:

1. Acquires OS-released installation, launcher and database-worker locks. PID
   numbers alone are never evidence that an installation is stopped
2. Preserves the entire previous data/config generation, including SQLite WAL,
   material, question banks, results, provider settings and authentication secrets
3. Makes a private, hash-checked candidate copy and requires free space for twice
   the copied bytes plus a 128 MiB migration reserve, after package extraction
4. Migrates and starts the actual new application against the candidate, without
   opening a browser. It stops all verification workers before activation
5. Replaces one installation pointer, selecting the complete matching app and
   study-state generation together. The ordinary shortcut resolves that pointer

Migration, startup or preactivation interruption leaves the previous pair
selected. Orphan candidate folders may remain; they are never automatically
adopted or deleted. Re-running the verified installer prepares a fresh candidate.
After activation, no automatic rollback occurs: newer work might already exist.
Directly running an inactive supported version refuses to open study data.

Use a local filesystem owned by your ordinary OS account. Network shares,
cloud-synced installation folders, links/junctions, hard-linked study files and
shared/foreign-owned state are unsupported. Keep adequate disk space; the reserve
is a safety check, not a bound on every future migration’s requirements. If a
fresh install is interrupted before it creates its installation marker, use a
new empty folder. A damaged immutable bootstrap fails closed and needs recovery
into a separate folder; repair does not overwrite its running Node executable.

The automated checks cover process interruption. They do not simulate physical
power failure or failing storage. In particular, Windows ordinary-user Node APIs
do not provide a proven durable directory-commit guarantee; keep an independent
backup before upgrading. This feature does not claim guaranteed recovery from
sudden power loss on Windows.
