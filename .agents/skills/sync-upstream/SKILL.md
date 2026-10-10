---
name: sync-upstream
description: Rebase this personal fork onto pingdotgg/t3code upstream/main and publish to origin only. Use when the user asks to pull upstream updates, sync the fork, update from the original repo, or rebase onto pingdotgg/t3code. Never pushes or opens PRs against pingdotgg.
---

# Sync upstream

Bring `pingdotgg/t3code` into this fork. Policy authority: [FORK.md](../../../FORK.md).

**Invariant:** push target is always `origin` (`9erson/t3code`). Never `upstream`, never any `pingdotgg` URL, never `gh pr create` against pingdotgg. If anything is ambiguous, **ask** — do not assume.

## Pre-flight (every run)

Run these checks in order. Stop and ask on any failure.

1. **Policy reminder** — restate: fetch from upstream, rebase onto `upstream/main`, force-with-lease to origin only.
2. **`upstream` remote** — must fetch `https://github.com/pingdotgg/t3code` (or equivalent). If missing:
   ```bash
   git remote add upstream https://github.com/pingdotgg/t3code
   git remote set-url --push upstream no_push
   ```
   If present but push URL is not `no_push`, set it. If fetch URL is wrong, ask before changing it.
3. **`rerere`** — `git config rerere.enabled true` (local, self-heal; do not commit config).
4. **Push-target audit** — list remotes (`git remote -v`). Refuse to continue if any remote's **push** URL contains `pingdotgg` (except the intentional `no_push` sentinel on `upstream`). `origin` push URL must be this fork.
5. **Clean tree** — `git status --porcelain` must be empty. If dirty, list files and stop; ask the user to commit or stash.
6. **Branch** — work on `main` (or ask if they want another branch).
7. **Drift check** — `git fetch origin` then compare `main` and `origin/main`. If they differ (e.g. GitHub "Sync fork" was used), show both tips and **ask** how to proceed before rebasing.

## Sync

```bash
git fetch upstream
git log --oneline HEAD..upstream/main
```

Show the incoming commit list. If empty, report "already up to date" and stop (no push).

Then rebase:

```bash
git rebase upstream/main
```

### On conflict

1. Pause. Never edit conflict markers or pick a side yourself.
2. Per conflicted file, summarize: your commit's change, upstream's change, and any `rerere` prior resolution if present.
3. Suggest a resolution in plain language; wait for the user's call.
4. After they decide, apply **only** what they approved, `git add` the file, continue with `git rebase --continue`.
5. Offer `git rebase --abort` at any pause. Use it immediately if they ask.

Repeat until the rebase finishes or is aborted.

## Publish

| Outcome | Action |
| --- | --- |
| Clean rebase (no conflicts) | `git push --force-with-lease origin main` |
| Conflicts were hand-resolved | Ask first, then `git push --force-with-lease origin main` if approved |
| Rebase aborted | Do not push |

Before every push, re-verify the destination is `origin` and the URL is this fork — never `upstream` / pingdotgg.

If `--force-with-lease` fails because `origin/main` moved, stop, show the mismatch, and ask. Do not fall back to `--force`.

## Post-sync housekeeping

Inspect the new range for lockfile / migration / install-relevant changes (`pnpm-lock.yaml`, `package.json`, DB/migration paths, etc.). Report what you find. **Ask** before running `vp i`, `vp run migrate-dev-db`, or similar. Never auto-run them.

## Ask, don't assume

Ask when: remotes look wrong, tree is dirty, `main` ≠ `origin/main`, rebase conflicts, force-with-lease fails, housekeeping might be needed, or any step could write outside this fork. Prefer a short question with concrete options over guessing.
