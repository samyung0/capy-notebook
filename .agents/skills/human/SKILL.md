---
name: human
description: >
  Framework for how coding tasks should be performed with instructions of knowledge grounding using stored catalog of user decisions and subagent review feedback loop for reviews. Trigger for any kind of coding tasks: code reviews, audits, refactoring, debugging, planning, implementation, also trigger when developers question or doubts the implementation or design: "why is this designed like this", "who made this".
---

# Human

We face issues in normal flows: user decisions get lost during complex work because they are pooly tracked, they usually live inside of context only. New work may then override the decisions and cause unexpected behaviors. Therefore we need to store all user decisions in durable files that MUST NOT be changed unless user makes another decision. Coding tasks can be done based on those decisions.

## User Decisions

User decisions covers all of product design choices, system design choices, trade-offs and compromises made to shape the system and products or to address implementation issues, that are intentionally made by users. A decision must be delivered via prompt messages.

User decisions should be stored in a dedicated folder `human` at root, containing only markdown files. The markdown files should be split according to how files in `openwiki` folder are structured, mimic the folder structure. If the decision doesn't fit, put it in a file called `miscellaneous.md`.

The Files are written for machines and agents to read, not human. **The goal is to store the most information with the least amount of words**:

- A decision starts with a precise description of what the user decided on and who is the user, followed by the issue the decision solved (optional), followed with a list of code references impacted by the decision (optional). Do not put how the code referenced is related, just list the address of the code.
- Remove all headings, frontmatter, file summaries, pleasantries. Use a simple bullet point for each decision and do not use line breaks.
- Look for opportunities to compact the semantics: "fast, deterministic, low-overhead" → tight (a tight loop).
- Use positive phrase over negation, stating the expected and correct instead of stating what should not happen.
- Do not record duplicate decisions.

## Coding Tasks

- Read `openwiki` for current behaviors and `human` for stored decisions to applicable domains at start.
- Use `ponytail` skill to derive a lazy solution.

If code changes are required:

- Check if user's decision or prompt or implementation items contradict the decisions made, do not implement and you MUST seek user's explicit decision and resolution, then record that decision before other changes.
- If the provided user decision conflicts or introduce behavior that conflicts with another decision, do NOT record, seek user's decisions again.
- After implementation, add supporting code references to `human` for new recorded decisions if applicable.
- NEVER modify `human` in other situations.

If implementation issues are found:

- NEVER fix on your own. A user decision is required and needs to be recorded. Propose a lazy solution in brief as recommendation
- If the provided user decision conflicts or introduce behavior that conflicts with another decision, seek user's decision agian.

## Subagent review-feedback loops

A separate subagent may be spinned up for review after full implementation in cases of large tasks.

The subagent must read the `human` folder for applicable domains as well. The subagents must not fix the issues on its own as issues require user explicit decisions. The subagents must report the findings to a temporary file where the main agent (orchestrator) can see.

After reviews from subagent(s), the main orchestrator summarizes the reports and ask user for decisions on how to address the issues and record them. If there are conflicts between decisions, ask for decisions again until no conflicts. Then the main orchestrator writes the fixes directly to the temporary files for the subagents. The subagents implements and records code references to the `human` decisions.

The main orchestrator sees subagents finished the fix, then spawns another subagent to do the same review and loops until no issues are surfaced from the subagents.

Give clear label for spawning subagents so they dont spawn their own subagents.
