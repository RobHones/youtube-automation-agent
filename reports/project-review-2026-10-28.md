# Project and AI subscription review

Reviewed on 28 October 2026.

The confirmed subscription connection defects are fixed. Automated checks pass, the ChatGPT adapter passed a live request, and npm audit reports zero known dependency vulnerabilities.

## Fixed

| Issue | Result |
| --- | --- |
| Switching from a saved subscription to Gemini/OpenAI retained the previous text provider | Both setup flows now save the explicit selection, preserving image and narration credentials |
| Legacy saved OpenAI text credentials passed validation but were ignored by generation | AITextService now initializes from those credentials |
| The ChatGPT walkthrough opened documentation but did not launch sign-in | It now reuses a verified ChatGPT login or runs codex login, displays sign-in output, rechecks authentication, and tests generation before saving |
| Concurrent Codex calls shared one output file | Every request uses a separate private temporary directory and cleans it afterward |
| CLI exits could cause an uncaught stdin error | Early EPIPE/EOF errors preserve the CLI diagnostic instead of crashing the process |
| Timeouts could leave CLI descendants or Cursor runs alive | CLI process trees/groups are terminated; Cursor operations have a deadline and cancel/dispose late handles |
| Subscription selection could inherit API authentication or alternate provider routing | Child environments remove API overrides; Claude/Codex login methods are checked before generation |
| Missing models could be misreported as missing CLI executables | Command errors now distinguish executable lookup failures from provider errors |
| Dependency audit initially reported 30 vulnerabilities | Updated dependencies and removed unused Google local-auth; the final audit reports zero |
| Advertised Node 18 support conflicted with current dependencies | Runtime requirement is now Node 22.13+; CI targets Node 22 and 24 |
| node-cron 4 removed the old stopped-task option and running property | Scheduler uses createTask, explicit start/stop, and getStatus, with lifecycle coverage |

## Verification

| Check | Result |
| --- | --- |
| npm test | 51 system groups and 44 subscription/setup runtime tests passed |
| Real slideshow rendering | Chromium image loading and FFmpeg MP4/timeline checks passed |
| npm run lint | Passed |
| npm audit | 0 vulnerabilities |
| npm ci dry run | Passed |
| git diff --check | Passed |
| Live ChatGPT adapter | Codex subscription login with gpt-5.6-luna returned READY |

Subscription tests exercise provider switching, authentication methods, environment isolation, concurrent outputs, failed and empty responses, stdin closure, process termination, output limits, and Cursor timeout/cleanup behavior.

## Setup and verification limits

The revised ChatGPT walkthrough was exercised with the existing CLI login, passed a live text request, and saved ChatGPT as the project's text provider using gpt-5.6-luna. YouTube credentials still need channel setup through npm run walkthrough.

Claude Code is not installed here, and no Cursor account connection was available for a live generation check. Their integration paths were checked against the CLI/SDK interfaces and tested with mocks. Successful generation with those accounts remains to be verified during setup.

The review and local tests do not verify YouTube channel access or actual uploads. CI configuration was updated; remote CI has not been run as part of this review.

## References

Authentication behavior was checked against the official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Dependency migrations used the official [sharp changes](https://sharp.pixelplumbing.com/changelog/v0.35.0/) and [node-cron migration guide](https://www.nodecron.com/migrating-from-v3.html).
