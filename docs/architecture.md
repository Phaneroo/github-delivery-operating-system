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
| `notify-release-approver` | `issues.opened` (label `production`) | Ping release approver |
| `authorize-deployment` | `issue_comment.created` (label `production`) | Dual approval → `ready-for-deploy` |
| `auto-assign-qa` | `issues.opened/labeled` (label `qa` or `qa-request`) | Assign QA team |
| `auto-qa-request` | `pull_request.opened/ready_for_review`, `push` to `main` | File a QA Request (and a backing Task, if none is linked) for every PR or direct push — safety net, not a gate |
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

## Data Flow

1. **Sprint:** User creates sprint issue (title `SPRINT -`) → sprint-child-creator parses body → child issues created with `Parent Sprint: #N`
2. **Sprint progress:** Child issue closed → auto-close-sprint updates burn-down → sprint auto-closed at 100%
3. **Release:** User creates production release issue → notify-release-approver pings approver
4. **Dual approval:** Both approvers comment → authorize-deployment adds `ready-for-deploy`
5. **Alerts:** Key events trigger telegram-issues (if secrets configured)

## Security

- **Secrets:** All tokens stored as `${{ secrets.* }}`; never hardcoded
- **Variables:** Approvers configured via repo variables; no usernames in workflows
- **Public-safe:** Repository content suitable for public release
