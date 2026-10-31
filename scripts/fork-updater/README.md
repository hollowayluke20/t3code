# Fork updater

The fork updater keeps Luke's T3 fork (the one with the microphone button) up to
date with upstream T3 releases. It runs in the background on the Mac mini once
an hour. You normally do not need to think about it: it either does nothing,
updates quietly, or sends a notification if something went wrong.

The program is `scripts/fork-updater/fork-updater.mjs`. The LaunchAgent in this
folder just runs `node scripts/fork-updater/fork-updater.mjs tick` every hour.

## What it does each hour

1. Asks GitHub for the latest **stable** upstream release of `pingdotgg/t3code`.
   Nightly and preview tags are ignored.
2. If there is nothing newer than the last base it handled, it stops. That is
   the normal case and costs a few seconds.
3. If there is a new stable base, it makes a temporary git worktree of the fork
   branch (`feat/mic-button`), merges the upstream tag into it, and runs the
   build checks (typecheck plus the focused voice, permissions and contracts
   tests).
4. It builds a fork archive and installs it as a new T3 version.
5. It waits until no T3 thread is busy (see below), then switches versions,
   restarts the T3 service, and runs health checks: the web UI answers, the
   running version is the new one, a one-word OK thread replies, and voice
   transcription of a test WAV works.
6. If anything after the switch fails, it rolls back to the previous version
   automatically and notifies you.
7. Every hour it also checks whether the T3 service is answering at all. If it
   is down, it tries one restart and tells you if that did not help.

Steps are written with timestamps to `~/.t3-fork-updater/updater.log`.

## Version naming

Fork builds use the upstream version plus a fork suffix and a build number,
for example `0.1.6-luke.1`, then `0.1.6-luke.2` for a later rebuild of the same
upstream base, and `0.1.7-luke.1` after the next upstream release. The number
always goes up, and the version is different from every upstream version so
T3's installer cannot reuse a cached upstream build by mistake.

The exact separator (for example `-luke.` or `+luke.`) is whatever the sandbox
install test recorded in `scripts/fork-updater/SANDBOX-FINDINGS.txt`. The
updater follows that file, or uses `-luke.<N>` when it is absent.

## Where the files are

| What                                | Where                                                           |
| ----------------------------------- | --------------------------------------------------------------- |
| Updater log                         | `~/.t3-fork-updater/updater.log`                                |
| launchd stdout/stderr               | `~/.t3-fork-updater/launchd.log`                                |
| State, lock, builds, built releases | `~/.t3-fork-updater/`                                           |
| Installed T3 versions               | `~/.t3/runtime/versions/`                                       |
| LaunchAgent plist                   | `~/Library/LaunchAgents/com.lukeholloway.t3-fork-updater.plist` |

`launchd.log` should normally be empty. If node itself crashes before the
updater can log, look there.

## Commands

Run these from the real repo (`~/Development/t3code-luke`):

```sh
node scripts/fork-updater/fork-updater.mjs status
node scripts/fork-updater/fork-updater.mjs check
node scripts/fork-updater/fork-updater.mjs run-now
node scripts/fork-updater/fork-updater.mjs rollback
```

- `status` - installed fork version, latest upstream release, the last run and
  its result, whether the T3 service is answering, and whether the hourly job
  is loaded.
- `check` - says whether a new upstream stable release exists. Changes nothing.
- `run-now` - runs the whole update check and update now, ignoring the retry
  back-off. Add `--force` to skip the wait for busy threads.
- `rollback` - switches back to the version that was running before the last
  update, restarts, health-checks, and notifies.
- `tick` - what launchd runs. You do not normally run this by hand.

## Install or uninstall the hourly job

Run this from the real repo, not from a temporary worktree: the plist hard-codes
the repo path, so installing from a worktree that you later delete would leave
a broken job.

```sh
scripts/fork-updater/install.sh            # dry run: prints what it would do
scripts/fork-updater/install.sh --apply    # writes the plist and loads the job
scripts/fork-updater/install.sh --print    # prints the generated plist only
scripts/fork-updater/uninstall.sh          # unloads the job and removes the plist
```

The install script validates the plist with `plutil -lint`, creates
`~/.t3-fork-updater`, and (with `--apply`) uses `launchctl bootstrap` for the
current user. It is safe to run again: it boots the old job out first. It does
not kickstart the job, so the first run happens on the next hourly interval.

`uninstall.sh` unloads the job and removes the plist. Logs and state in
`~/.t3-fork-updater` are left alone, and the running T3 version is not changed.

## Notifications

You get two kinds:

- a macOS banner titled **T3 updater**, and
- a thread in the `grad-application-pipeline` project (provider
  `claude_gateway_luke`, model `claude-haiku-5-5`).

The thread titles are:

- `T3 update: <version> installed`
- `T3 update FAILED: <reason>, still on <old version>`

If T3 is down and cannot host a thread, the banner is still sent and the
failure is written to the log.

## Voice transcription

The T3 server finds whisper through environment variables:

- `T3CODE_WHISPER_BIN` - path to `whisper-cli`. Without it, the server looks
  for `whisper-cli` and then `whisper-cpp` on `PATH`.
- `T3CODE_WHISPER_MODEL` - path to a `ggml-*.bin` model.

The default place on this machine is `~/.t3-voice`, with the binary at
`~/.t3-voice/bin/whisper-cli` and models in `~/.t3-voice/models/ggml-*.bin`
(for example `ggml-small.en.bin`). If whisper or the model cannot be found,
transcription reports "unavailable" and the updater's health check catches it.

## The busy-thread rule

The updater will not restart T3 while any thread is running a turn. If threads
are busy it leaves the current version in place and tries again on the next
hourly tick. After 12 hours of waiting it sends one notification saying the
update is ready but threads are busy. `run-now --force` skips this wait, which
may interrupt work.

## Disable it

Run `scripts/fork-updater/uninstall.sh`. That stops the hourly job. The updater
can still be run by hand with the commands above. To turn the schedule back
on, run `scripts/fork-updater/install.sh --apply` again.

## Troubleshooting

- **Merge conflict.** Upstream changed lines that the fork also changed. The
  updater aborts its temporary merge and notifies you; nothing is installed.
  The fork branch needs a manual merge: in `~/Development/t3code-luke`, fetch
  and merge the upstream tag, resolve the conflict, commit, and then run
  `run-now` (or wait for the next hour). The conflicting files are named in the
  log.
- **Health check failed.** The update was rolled back automatically, so T3 is
  still running the old version and the UI keeps working. The notification says
  `still on <old version>`. Look at `status` and `updater.log`, fix the fork
  build, then run `run-now`.
- **Nothing seems to happen.** Run `status` and `check`. There may simply be no
  new stable upstream release, or threads may be busy.
- **The service is down.** `tick` tries one restart and notifies you if it is
  still down. `status` shows whether the service answers.
- **A build or test failed.** The failing step and the last lines of output are
  in the notification and in `updater.log`. The old version stays installed.
- **The job is not running.** `status` shows whether the LaunchAgent is loaded.
  Run `install.sh` (dry run) to see the paths, then `install.sh --apply`.
