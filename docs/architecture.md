# Architecture

## Overview

The GitHub Delivery Operating System is a **direct-copy** governance layer. Workflows and templates are copied into consumer repositories. No `workflow_call` or external references. Each workflow runs natively in the consumer repo.

## Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Event-driven** | Workflows trigger on GitHub events (issues, PRs, labels, comments) |
| **Label-based governance** | Lifecycle stages enforced via labels: `intake`, `bug`, `sprint`, `planning`, `task`, `qa`, `qa-request`, `production`, `release`, `approval`, `ready-for-deploy` |
| **Structured intake** | YAML issue forms with required fields for sprints, tasks, bugs, QA, releases |
| **Controlled gates** | Production release requires approval; dual approval (release approver + QA lead) |
| **Real-time visibility** | Telegram alerts on key events |
| **Self-contained** | All workflows run in consumer repo; no external calls |

## Workflows (Installed Directly)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `sprint-child-creator` | `issues.opened` (title contains `SPRINT -`) | Parse Sprint Features, create child issues |
| `auto-close-sprint` | `issues.closed` (body contains `Parent Sprint`) | Update burn-down, auto-close at 100% |
| `notify-release-approver` | `issues.opened` (label `production`), `workflow_dispatch` | Ping release approver; post the release roll-up (plain-English What Changed notes from the QA Requests the release likely covers) |
| `authorize-deployment` | `issue_comment.created` (label `production`) | Dual approval → `ready-for-deploy`; closes the Tasks/QA Requests `auto-qa-request` filed before the release was requested (skipping ones whose PR hasn't merged) |
| `auto-assign-qa` | `issues.opened/labeled` (label `qa` or `qa-request`) | Assign QA team |
| `auto-qa-request` | `pull_request.opened/ready_for_review/reopened/synchronize/closed`, `push` to `main` | QA reminder for every change that reaches `main` and isn't docs/settings-only — safety net, not a gate. Default **rolling**: adds a line to the one open rolling QA issue (direct pushes, merged PRs). **per-change**: files a QA Request (+ Task if none is linked) per PR/push, and closes them if the PR is closed unmerged |
| `qa-rollup-approval` | `issue_comment.created`, `issues.edited` (label `qa-rollup`) | `QA_APPROVER` approves (phrase/emoji comment or the Approved box) → closes the rolling issue; declines → keeps it open |
| `telegram-issues` | `issues`, `issue_comment`, `pull_request` | Send Telegram alerts |
| `setup-labels` | `workflow_dispatch` | Create required labels |

## Issue Templates

| Template | Labels | Purpose |
|----------|--------|---------|
| `sprint_planning` | `sprint`, `planning` | Sprint creation; features one per line → child issues |
| `task` | `task` | Structured tasks with priority, status, acceptance criteria |
| `bug_report` | `bug`, `qa` | Bug reports with platform, severity, steps |
| `qa_request` | `qa-request` | QA testing request |
| `production_release_qa_signoff` | `release`, `production`, `approval` | Production release & QA sign-off |
| `config` | — | Blank issues, contact links |

## Lifecycle Labels

```
intake → sprint → qa → production → approved / rejected
  bug      planning    qa-request    release
  task                 approval      ready-for-deploy
```

## Configuration

Approvers and assignees are configured via **repo variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Purpose |
|----------|---------|
| `RELEASE_APPROVER` | Username for notify + authorize workflows |
| `QA_APPROVER` | Username for dual approval |
| `QA_ASSIGNEES` | Comma-separated usernames for auto-assign-qa |
| `PROJECT_NAME` | Optional; shown in release notifications |
| `DELIVERY_OS_AUTO_QA_MODE` | Optional; `rolling` (default), `per-change`, or `off` |
| `DELIVERY_OS_AUTO_QA` | Optional; 1.8.0 setting, still honored: `all` → per-change, `pr-only` → direct pushes add nothing, `off` |
| `DELIVERY_OS_AUTO_TASK` | Optional, per-change mode; `false` → direct pushes with no linked issue file only a QA Request, no Task |
| `DELIVERY_OS_AUTO_QA_QUIET_PATHS` | Optional; globs whose changes alone file nothing (default: docs/settings; `none` disables) |
| `DELIVERY_OS_AUTO_CLOSE` | Optional; `false` stops `authorize-deployment` closing auto-filed issues on release |

## Data Flow

1. **Sprint:** User creates sprint issue (title `SPRINT -`) → sprint-child-creator parses body → child issues created with `Parent Sprint: #N`
2. **Sprint progress:** Child issue closed → auto-close-sprint updates burn-down → sprint auto-closed at 100%
3. **Release:** User creates production release issue → notify-release-approver pings approver and posts the release roll-up
4. **Dual approval:** Both approvers comment → authorize-deployment adds `ready-for-deploy`
5. **Alerts:** Key events trigger telegram-issues (if secrets configured)

## Security

- **Secrets:** All tokens stored as `${{ secrets.* }}`; never hardcoded
- **Variables:** Approvers configured via repo variables; no usernames in workflows
- **Public-safe:** Repository content suitable for public release
