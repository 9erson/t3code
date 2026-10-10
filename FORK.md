# Fork policy

This checkout is a personal fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).
**Nothing from this repo is ever pushed or PR'd to the original owner.**

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `https://github.com/9erson/t3code` | **Only** push / PR target |
| `upstream` | `https://github.com/pingdotgg/t3code` | Fetch only (`push` URL is `no_push`) |

## Hard rules

1. Push only to `origin` (`9erson/t3code`). Never push to `upstream` or any `pingdotgg` URL.
2. Never open a GitHub PR against `pingdotgg/t3code`. PRs (if any) target this fork only.
3. Pull updates from upstream with the [`sync-upstream`](.agents/skills/sync-upstream/SKILL.md) skill — rebase your commits onto `upstream/main`, resolve conflicts yourself, then publish with `git push --force-with-lease`.

## Soft guards

- `.claude/settings.json` denies Claude-driven `git push` / `gh pr create` aimed at pingdotgg.
- Deny rules are **not** guaranteed under bypass-permissions mode. The sync skill's pre-flight push-target check is the operative guard during syncs; humans and other harnesses must follow this file.

## Customizations that stay fork-only

Prefer files upstream does not have (`FORK.md`, `.agents/skills/sync-upstream/`, `.claude/settings.json`) so syncs stay cheap. Keep edits to shared files (`AGENTS.md`, app source) intentional — those are where rebase conflicts appear.
