'use strict';

// `install --with-agents`: the delivery-ops skill as an AGENTS.md section, for
// any coding agent that reads that file (Codex, Cursor, GitHub Copilot, Cline,
// opencode, ...) and so for any model behind it. It is
// generated from the one skill, never a second copy to maintain. The section
// sits between markers so a repo's own AGENTS.md text is never touched.

const BEGIN = '<!-- BEGIN github-delivery-os:delivery-ops -->';
const END = '<!-- END github-delivery-os:delivery-ops -->';

const PREAMBLE = `# Delivery OS (delivery-ops)

This repo uses GitHub Delivery OS. The rest of this section tells you how to operate it with the \`gh\` CLI. It needs no special tools: only shell access, \`gh\` (logged in) and \`git\`.

Working rules, whatever model you are:

- Do one step at a time, and run the exact command shown rather than a paraphrase. Read each command's output before the next step.
- Issue bodies must use the \`### Field Label\` headings exactly as written below; the workflows parse that text.
- Anything visible to other people (creating or commenting on issues, approving a release, changing variables) needs the user's yes first, unless the autonomous-tracking section says otherwise.
- If a command fails or the output is not what you expected, say so and stop; do not guess.
`;

// True only for a complete block: both markers, BEGIN first.
function hasBlock(text) {
  const from = text.indexOf(BEGIN);
  return from !== -1 && text.indexOf(END, from) !== -1;
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

// Words that only make sense inside Claude Code.
function neutralise(text) {
  return text
    .replace(/Claude Code skill/g, 'skill')
    .replace(/a Claude session/g, 'an assistant session')
    .replace(/Claude/g, 'the assistant');
}

function agentsSection(skillText) {
  const body = neutralise(stripFrontmatter(skillText.replace(/\r\n/g, '\n'))).replace(/^# Operate Delivery OS\n+/, '## Operate Delivery OS\n\n');
  return `${BEGIN}\n${PREAMBLE}\n${body.trimEnd()}\n${END}\n`;
}

// Put the section into existing AGENTS.md text: replace our block if present,
// else append after whatever is there.
function mergeAgentsMd(existing, section) {
  if (!existing) return section;
  const from = existing.indexOf(BEGIN);
  const to = existing.indexOf(END, from);
  if (hasBlock(existing)) return existing.slice(0, from) + section.trimEnd() + existing.slice(to + END.length);
  return existing.trimEnd() + '\n\n' + section;
}

// Take our block out, leaving the rest. Returns null if nothing else is left.
function removeAgentsBlock(existing) {
  if (!hasBlock(existing)) return existing;
  const from = existing.indexOf(BEGIN);
  const to = existing.indexOf(END, from);
  const rest = (existing.slice(0, from).trimEnd() + '\n\n' + existing.slice(to + END.length).trimStart()).trim();
  return rest ? rest + '\n' : null;
}

module.exports = { BEGIN, END, hasBlock, agentsSection, mergeAgentsMd, removeAgentsBlock };
