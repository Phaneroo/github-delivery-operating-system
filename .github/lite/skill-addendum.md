## Which install is this? (full or lite)

Read `.github/delivery-os.json` in the repo (`gh api repos/<owner>/<repo>/contents/.github/delivery-os.json --jq '.content' | base64 -d`). A `"bundle": "lite"` means the **lite** install, built for one-person teams and small projects; no `bundle` field means **full**, which is everything below as written.

On a **lite** repo, skip everything about QA, because none of it is installed:

- **No QA Requests, no rolling QA issue, no `auto-qa-request` filings, no QA assignment, no Telegram.** Don't offer to file a QA Request or approve the rolling QA list, and ignore the "The rolling QA issue", "Release roll-up" and "Writing the What Changed changelog" sections and the `qa-request` / `qa-rollup` / `QA_APPROVER` / `QA_ASSIGNEES` / `DELIVERY_OS_AUTO_QA*` parts of the pre-flight and cleanup checks.
- **What lite does have:** Sprint Planning, Task and Bug issues (with the sprint child-creation and auto-close), and a plain **Production Release** issue.
- **Releases are one approval.** Opening a Production Release pings `RELEASE_APPROVER`; that person comments `approved` to authorize it (`ready-for-deploy`) or `declined` to hold it back (`declined`; approving again lifts it). There is no QA approver. The login check in "Commenting as an approver" still applies, for `RELEASE_APPROVER` only.
- **Variables:** only `RELEASE_APPROVER` matters. If it's unset, the install can set it to the person who ran it: `npx github-delivery-os@latest install --bundle lite --set-approvers .` (never overwrites an existing value). Don't set it yourself unless asked, since it names a real person.
- **Updating keeps it lite.** Run `install` with `--bundle lite` (a plain `--update` already keeps the repo's current bundle). Moving to full is `--bundle full`.

