'use strict';

// Lite ships its own authorize-deployment and notify-release-approver. This
// guards them against drifting from the full versions: it records exactly how
// they differ today (the QA-specific lines), and fails if either side changes
// in a way the other doesn't mirror. If it fails, a change to one workflow
// probably needs making in the other: port it to .github/lite/workflows (or
// the full one), or, if the difference is intended, update the lists below.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');

const root = path.join(__dirname, '..');
const SNAPSHOT = {
  "authorize-deployment": {
    "cut": null,
    "fullOnly": [
      "name: Authorize Deployment on Dual Approval",
      "QA_APPROVER: ${{ vars.QA_APPROVER || 'qa-approver' }}",
      "const qaApprover = process.env.QA_APPROVER;",
      "const { releaseVerdict, qaVerdict } = computeVerdict(comments, releaseApprover, qaApprover);",
      "// No verdict from a release or QA approver yet: routine discussion,",
      "if (!releaseVerdict && !qaVerdict) return;",
      "qaVerdict,",
      "body: releaseVerdict === \"declined\"",
      "? \"🔴 **Release Declined**\\n\\nThis release requires additional fixes before production deployment. Only the release approver who declined it can lift the decline, by approving.\"",
      ": \"🔴 **Release Declined by QA**\\n\\nQA has declined this release; it requires additional fixes before production deployment. Only the QA approver who declined it can lift the decline, by approving.\"",
      "body: \"🟢🚀 **Deployment Authorized**\\n\\nDual approval received. This release is cleared for production deployment.\"",
      "// Close what auto-qa-request filed for work that's in this",
      "body: `🧹 Closed ${toClose.length} auto-filed Task/QA Request issue(s) covered by this release: ${toClose.map((n) => `#${n}`).join(\", \")}`"
    ],
    "liteOnly": [
      "name: Authorize Release (Lite)",
      "const { releaseVerdict } = computeVerdict(comments, releaseApprover, \"\");",
      "// No verdict from the release approver yet: routine discussion,",
      "if (!releaseVerdict) return;",
      "// No QA approver in lite: the release approval stands alone.",
      "qaVerdict: releaseVerdict === \"approved\" ? \"approved\" : null,",
      "body: \"🔴 **Release Declined**\\n\\nThis release requires additional fixes before production deployment. Approve it again once they land to lift the decline.\"",
      "body: \"🟢🚀 **Deployment Authorized**\\n\\nRelease approval received. This release is cleared for production deployment.\"",
      "// Close what the delivery-ops skill filed for work that's in this",
      "body: `🧹 Closed ${toClose.length} auto-filed issue(s) covered by this release: ${toClose.map((n) => `#${n}`).join(\", \")}`"
    ]
  },
  "notify-release-approver": {
    "cut": "\n  release-rollup:",
    "fullOnly": [
      "workflow_dispatch:",
      "inputs:",
      "release_issue:",
      "description: \"Production Release issue number to refresh the roll-up for\"",
      "required: true",
      "if: github.event_name == 'issues' && contains(github.event.issue.labels.*.name || fromJSON('[]'), 'production')",
      "let qaRecommendation = \"Not specified\";",
      "if (issueBody.includes(\"Approve for Production\")) qaRecommendation = \"Approve for Production\";",
      "else if (issueBody.includes(\"Reject Release\")) qaRecommendation = \"Reject Release\";",
      "else if (issueBody.includes(\"Conditional Approval\")) qaRecommendation = \"Conditional Approval\";",
      "\"🚨 \" + mentions + \" Production Release requires approval.\\n\\n\" +",
      "\"**QA Recommendation:** \" + qaRecommendation + \"\\n\\n\" +",
      "\"Please review the sprint delivery and QA sign-off details above before approving deployment.\\n\\n\" +",
      "\"🔒 Deployment must not proceed without your approval.\";"
    ],
    "liteOnly": [
      "if: contains(github.event.issue.labels.*.name || fromJSON('[]'), 'production')",
      "\"🚨 \" + mentions + \" This release is ready for your go-ahead.\\n\\n\" +",
      "\"Comment **approved** to authorize it, or **declined** to hold it back.\";"
    ]
  }
};

// Lines of a workflow, trimmed, comments and blanks dropped; `cut` ends the
// compared part early (notify's roll-up job, which lite doesn't have).
function lines(file, cut) {
  let text = fs.readFileSync(file, 'utf8');
  if (cut && text.includes(cut)) text = text.slice(0, text.indexOf(cut));
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

for (const [wf, expected] of Object.entries(SNAPSHOT)) {
  test(`lite ${wf}.yml differs from the full one only where it is meant to`, () => {
    const full = lines(path.join(root, '.github', 'workflows', `${wf}.yml`), expected.cut);
    const lite = lines(path.join(root, '.github', 'lite', 'workflows', `${wf}.yml`));
    assert.deepEqual(full.filter((l) => !lite.includes(l)), expected.fullOnly, `lines only in the full ${wf}.yml changed: port the change to the lite one or update this test`);
    assert.deepEqual(lite.filter((l) => !full.includes(l)), expected.liteOnly, `lines only in the lite ${wf}.yml changed: check it still matches the full one or update this test`);
  });
}
