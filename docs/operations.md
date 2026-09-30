# Operating Examify

Run these commands from your Examify checkout, as the user that runs the app.
The installer does not start, stop, or restart services.

- [Data location](#where-your-familys-data-lives)
- [Deploy and HTTPS](#deploy)
- [Update](#upgrading)
- [Backup, restore and rollback](#backups-and-restore)
- [Troubleshooting](troubleshooting.md)

## Where your family's data lives

Everything that belongs to your family lives in one **family data folder**, picked in
this order: `EXAMIFY_DATA_DIR`; else the folder of an explicit SQLite `DATABASE_URL`
that is outside the checkout (a mounted volume keeps family content next to its
database); else `./data` inside the checkout (already gitignored). The running app never
writes into tracked checkout content: inside the checkout it writes only `./data` (the
test suites use `tests/.tmp/…`) and `.env` (the API keys the `/onboarding` wizard saves),
so `git pull` never conflicts with your content, and a folder outside the checkout
survives deleting and re-cloning it. The database (`DATABASE_URL`) and the mail outbox
(`MAIL_OUTBOX_DIR`) may live elsewhere, but never inside the checkout outside `./data`:
the app, `pnpm db:migrate` and the installer refuse that.
`pnpm examify:data paths` prints the folder, database and outbox this checkout uses.

| In the data folder                          | Holds                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `app.db` (+ `-wal`, `-shm`)                 | Accounts, households, progress, drafts (unless `DATABASE_URL` is set) |
| `outbox/`                                   | Local mail outbox: sign-in links and codes — **secret**               |
| `content/subjects/<id>/`                    | Wizard subjects: `subject.json`, `bank.ir.json`, notes                |
| `content/source-pdfs/<id>/`                 | Uploaded study PDFs                                                   |
| `content/generated/`                        | Generated questions; `keys/` holds the answer keys — **secret**       |
| `.examify-ingest/`                          | Generate run manifests and caches                                     |
| `backups/`                                  | Backup archives (database, answer keys, `.env`) — **secret**          |
| `migration-conflicts/`, `before-restore-*/` | Only after an upgrade or a forced restore — **secret**                |
| `.examify-data.json`, `.gitignore`          | Marker; `*` so the folder is never committed                          |

`.env` stays in the checkout and holds `AUTH_SECRET`, `SETUP_BOOTSTRAP_SECRET`, API
keys and mail passwords. `pnpm db:migrate` creates the folder `0700`; answer keys,
backups and outbox messages are `0600` (see [`SECURITY.md`](../SECURITY.md)).

**Outside the checkout.** If you might ever delete and re-clone the checkout, answer the
installer's "Family data folder" prompt with a folder outside it, such as
`/var/lib/examify` (or run `./install.sh --data-dir /var/lib/examify`). The user that
runs Examify must be able to create it, or own it empty
(`sudo mkdir /var/lib/examify && sudo chown "$USER" /var/lib/examify`). The app refuses
to boot with a folder that overlaps the checkout: a relative path resolves against the
checkout (never the working directory); inside the checkout only `./data` or a folder
under it is allowed; never the checkout itself or a folder that contains it; no leading
`~` (the installer expands it, `.env` does not), quotes, newlines, `$` or ` #` — and the
same goes for `DATABASE_URL` and `MAIL_OUTBOX_DIR` (Next expands `$VAR` in env files, the
command-line tools do not).
`pnpm db:migrate` also refuses an existing folder that holds files that are not
Examify's.

**Moving the folder.** Stop the server and run `pnpm examify:backup`. In `.env`, set
`EXAMIFY_DATA_DIR` to the new folder and delete `DATABASE_URL` (it would keep the
database where it is). Then `pnpm examify:restore <archive>`, `pnpm db:migrate`, and
start the server. Delete the old folder once the app works.

> Never run `git clean -x` / `-X` (for example `git clean -fdx`) or `git stash -a` in the
> checkout: with the default `./data` they delete, or stash away, the database, the
> answer keys and `.env`. Commit local edits instead of stashing them.

## Deploy

Complete the [installation](installation.md) and [configuration](configuration.md)
first. Use a service manager to run `pnpm start` from the checkout as the same
OS user that owns the data. Configure its working directory, Node 22/pnpm PATH,
environment, restart policy and logs. The installer does not create that service.

For a manual deployment with configuration already in place:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm start
```

Run `pnpm db:migrate` before `pnpm start` on every deploy — the server does not migrate
itself on boot, and in production it never creates the database: a missing file (say, an
unmounted volume) fails closed instead of serving a fresh, empty instance, and
`GET /api/health` answers 503 with a reason code only (`db_missing`; `unsafe_data_dir`
or `db_error` for the other failures). Put the family data folder on **persistent
storage** and point `EXAMIFY_DATA_DIR` at it — in a container, mount a volume (for
example at `/data`) and set `EXAMIFY_DATA_DIR=/data`. `DATABASE_URL` is optional. Set
the [required environment variables](configuration.md) (`AUTH_MODE` included), and healthcheck `GET /api/health`.

The checkout holds only code, committed content and `.env`. The wizard saves API keys to
that `.env`; on a host that rebuilds the checkout on every deploy, set them as host env
vars instead. Back up with `pnpm examify:backup` (see
[Backups and restore](#backups-and-restore)).

### Deploying with HTTPS

`SITE_URL` must equal the public origin family devices open (scheme, host and port).
Invite and sign-in links are built from it, and the session cookie follows it. Plain
http works on a home LAN but is unencrypted: passwords, codes and the session cookie
cross the network in clear. Use HTTPS for anything beyond the home network.

**Caddy** (automatic certificates):

```caddy
exam.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then set `SITE_URL=https://exam.example.com` and restart. **Cloudflare Tunnel** also works
(no open inbound ports): route `exam.example.com` to `http://localhost:3000`.

**nginx** must forward the original host and scheme, or Next.js Server Actions reject
requests and sign-in fails:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**Client IP for rate limits.** Sign-in limits are keyed by the client IP from one header,
`CLIENT_IP_HEADER`. The default, `x-forwarded-for`, uses the last X-Forwarded-For entry
and suits a single reverse proxy that appends to it (Caddy, Traefik, nginx as above,
most PaaS edges). Set `x-real-ip` only if your proxy overwrites X-Real-IP with the peer
address, and `cf-connecting-ip` only if the origin is reachable **exclusively** through
Cloudflare (a Tunnel, or a firewall that admits only Cloudflare). Don't expose
`next start` directly to the internet: with no proxy, the client controls
X-Forwarded-For. Password sign-in and mailbox codes also have per-account limits that
don't depend on the IP.

## Upgrading

Stop the server, then run this from the checkout as the user that runs Examify:

```bash
./install.sh --upgrade
```

Commit local code edits first. You need a configured Git checkout on a branch
with an upstream, compatible Node, pnpm and tar. The installer checks ownership,
local changes, merge conflicts and running-server health before modifying data.
Do not use `--allow-running` to upgrade a live Examify process.

It backs up the old version and data, moves legacy checkout content into the
family data folder, merges upstream, installs dependencies, migrates, builds and
verifies. Keep the printed backup path; restart the service only after success.
The database stays at its existing configured location.

If it fails, fix the reported problem and rerun `./install.sh --upgrade`, or use
`./install.sh --rollback <archive>` to return to the pre-upgrade version and data.
Follow the exact command printed by the failed run, especially on an older
installer. Interrupted upgrades preserve their usable rollback point. Conflicting
legacy content is kept under `<data folder>/migration-conflicts/`; inspect it
rather than deleting it blindly. Previously deleted built-in subjects may return.

**First upgrade from an older install.** Its `install.sh` has no `--upgrade`, and a plain
`git pull` strands your wizard content in the checkout: this version no longer reads it
there, and `pnpm db:migrate` refuses until it is moved. Run the new installer from inside
the checkout instead:

```bash
cd /path/to/examify    # your checkout
git fetch origin && git show origin/main:install.sh | bash -s -- --upgrade
```

That runs exactly the installer the upgrade moves to (no download; it works for a private
fork too). `curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash -s -- --upgrade`
does the same from the public repo. Stop the server first; without a terminal, add
`--yes` to answer the "is the server stopped?" question. If it stops before the merge,
rerun or roll back the same way (`… | bash -s -- --upgrade`, or
`… | bash -s -- --rollback <archive>`). Later upgrades use `./install.sh --upgrade`.

## Backups and restore

```bash
pnpm examify:backup    # same as: node scripts/examify-data.mjs backup
```

This writes `<data folder>/backups/examify-backup-<time>-<id>.tar.gz` (`0600`): a
consistent snapshot of the database (safe while the server runs), the family content,
generate run manifests, and the checkout's env files (`.env`, `.env.local`,
`.env.production`, `.env.production.local`, whichever exist). It leaves out the mail
outbox, earlier backups and the generate cache (`--include-cache` adds the cache).
`--no-env` leaves out the env files; `--out DIR` writes somewhere else outside the checkout.
The command verifies the archive before reporting success. If it reports
`content_changing`, stop editing questions and retry the backup.

**An archive holds secrets and answer keys.** Copy it off the machine (another computer,
an encrypted drive) and keep it private: a backup that lives only next to the data does
not survive a lost disk. Nothing deletes old archives.

Nightly, from the crontab of the user that runs Examify (`crontab -e`). Cron starts in
your home folder with a minimal `PATH`, so use absolute paths (`command -v node` prints
node's):

```cron
30 3 * * * /usr/bin/node /home/examify/examify/scripts/examify-data.mjs backup --repo /home/examify/examify >> /home/examify/examify-backup.log 2>&1
```

It reads `EXAMIFY_DATA_DIR` / `DATABASE_URL` from the checkout's env files, like the app.
If your service manager sets them instead, set them on the cron line too.

**Restore on this machine.** Stop the server, then `pnpm examify:restore <archive>`. It
refuses while the server answers, checks every file against the archive's manifest, and
refuses a backup from a newer Examify. When the data folder already holds a database or
content, add `--force`: the current data is moved aside to
`<data folder>/before-restore-<time>/`, never deleted (if the restore fails after that,
the error names that folder). `--with-env` also puts back the archived env files (a
current one is kept as `<name>.before-restore-<time>.local`), and the data then goes to
the folder those restored files name. Then run `pnpm db:migrate` and start the
server.

**Restore on a new machine.** Copy the archive over, then:

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash -s -- --restore /path/to/examify-backup-….tar.gz
# or, in a clone: ./install.sh --restore /path/to/examify-backup-….tar.gz
```

The installer clones if needed, installs, restores the database, the family content and
the archived env files (`.env`, `.env.local`, `.env.production*`; or asks for a new
`.env` when the backup has none), then migrates and builds. The data goes to the family
data folder those archived files name (`./data`
unless the old install used another one); if the user that runs Examify cannot create
that folder, create it for them first. Don't set `EXAMIFY_DATA_DIR` / `DATABASE_URL` or
`--data-dir` for such a restore: the restored `.env` decides. Change `SITE_URL` in `.env`
if the new machine has a different address.

**Roll back an upgrade.** `./install.sh --rollback <archive>` takes a pre-upgrade backup
(only those record the version to go back to). With the server stopped, it first checks
the whole archive (every file against its manifest; a damaged or incomplete one changes
nothing), then resets the checkout to that commit (`git reset --keep`, which refuses to overwrite local changes),
restores the database, family content, `.env` and the checkout's content from the
archive — the current data and `.env` are moved aside as above, not deleted — then
reinstalls and puts back the pre-upgrade build, or rebuilds. It checks for a running
server before touching the checkout (`--allow-running` does not skip the local ports:
the restore would refuse them anyway).
