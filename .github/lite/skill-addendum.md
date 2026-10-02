## Which install is this? (full or lite)

Read `.github/delivery-os.json` in the repo (`gh api repos/<owner>/<repo>/contents/.github/delivery-os.json --jq '.content' | base64 -d`). A `"bundle": "lite"` means the **lite** install, built for one-person teams and small projects; no `bundle` field means **full**, which is everything below as written. A lite repo may also list `"packs"`: optional pieces added later with `npx github-delivery-os add <pack>` (`qa`, `telegram`).

On a **lite** repo, skip whatever isn't installed. With no `qa` pack, none of the QA machinery is:

- **No QA Requests, no rolling QA issue, no `auto-qa-request` filings, no QA assignment** (unless the `qa` pack is added), **no Telegram** (unless the `telegram` pack is added). Don't offer to file a QA Request or approve the rolling QA list, and ignore the "The rolling QA issue", "Release roll-up" and "Writing the What Changed changelog" sections and the `qa-request` / `qa-rollup` / `QA_APPROVER` / `QA_ASSIGNEES` / `DELIVERY_OS_AUTO_QA*` parts of the pre-flight and cleanup checks.
- **What lite does have:** Sprint Planning, Task and Bug issues (with the sprint child-creation and auto-close), and a plain **Production Release** issue.
- **Releases are one approval** (until the `qa` pack is added; then a release needs the QA approver too and `QA_APPROVER` matters, as on full). Opening a Production Release pings `RELEASE_APPROVER`; that person comments `approved` to authorize it (`ready-for-deploy`) or `declined` to hold it back (`declined`; approving again lifts it). Without the pack there is no QA approver. The login check in "Commenting as an approver" still applies, for `RELEASE_APPROVER` only.
- **Variables:** without the `qa` pack only `RELEASE_APPROVER` matters. If it's unset, the install can set it to the person who ran it: `npx github-delivery-os@latest install --bundle lite --set-approvers .` (never overwrites an existing value). Don't set it yourself unless asked, since it names a real person.
- **Adding what's missing is cheap.** If they want QA sign-off or Telegram later, don't set it up by hand: preview `npx github-delivery-os add qa --dry-run .`, then run it after they confirm (`remove qa` takes it away again; it deletes the files only the pack needs). `add qa` makes releases need a QA approver, so tell them to set `QA_APPROVER` and `QA_ASSIGNEES`.
- **Updating keeps it lite.** Run `install` with `--bundle lite` (a plain `--update` already keeps the repo's current bundle). Moving to full is `--bundle full`.

