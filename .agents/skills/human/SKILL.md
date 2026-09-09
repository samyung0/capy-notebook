---
name: human
description: >
  Framework for how coding tasks should be performed with instructions of knowledge grounding using stored catalog of user decisions and subagent review feedback loop for reviews. Trigger for any kind of coding tasks: code reviews, audits, refactoring, debugging, planning, implementation, also trigger when developers question or doubts the implementation or design: "why is this designed like this", "who made this".
---

# Human

We face issues in normal flows: user decisions get lost during complex work because they are pooly tracked and they usually live inside of context only. When we start new tasks/spawn new agents, the agents may then override original codes and cause unexpected behaviors. Documentation does not prevent this because docs change with the code, nothing prevents an agent from changing both accidentally. Therefore we need to store all user decisions in durable files that MUST NOT be changed unless user makes another decision. Coding tasks can be done based on those decisions.

## User Decisions

User decisions covers all of product design choices, system design choices, trade-offs and compromises made to shape the system and products or to address implementation issues, that are intentionally made by users. **Only  decisions that brings about a change in current behavior should be recorded.** A decision must be delivered via prompt messages.

User decisions should be stored in a dedicated folder `human` at root, containing only markdown files. The markdown files should be split according to how files in `openwiki` folder are structured, mimic the folder structure. If the decision doesn't fit, put it in a file called `miscellaneous.md`. 

The Files are written for machines and agents to read, not human. **The goal is to store the most information with the least amount of words**:

- A decision starts with a precise description of what the user decided on and who is the user, followed by the issue the decision solved (optional), followed with a list of code references impacted by the decision (optional). Do not put how the code referenced is related, just list the address of the code.
- Remove all headings, frontmatter, file summaries, pleasantries. Use a simple bullet point for each decision and do not use line breaks.
- Look for opportunities to compact the semantics: "fast, deterministic, low-overhead" → tight (a tight loop).
- Use positive phrase over negation, stating the expected and correct instead of stating what should not happen.
- Do not record duplicate decisions.

Decisions recorded should be concise about a change's mian delivery rather than a listing out the inventories (that is job for documentation). If the prompt contains many decisions, split the decisions into different bullet points. If a decision needs to be overriden, remove the original decision unless specified otherwise.

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

The subagent must read the `human` folder for applicable domains as well. The subagents must not fix the issues on its own as issues require user explicit decisions. The reviewer writes the review to a temp file under /private/tmp so it survives main's context compaction and later agents can read it.

Main summarizes findings and asks the user for decisions, repeating until decisions do not conflict, then records them. Main applies the fixes decided because it holds the implementation context. Delegate a fix only when it is bounded and fully specified, and then to one executor per disjoint path set, each in its own worktree.

Recheck by resuming the original reviewer with the decided finding list: it verifies only those findings plus regressions the fix introduced, and reports nothing adjacent. Spawn one fresh reviewer for the closing pass only after every decided finding is confirmed fixed. New findings from the closing pass go to the user as a new batch; they do not restart the loop automatically. Never resume a subagent to collect a result it already returned.

Parallel reviewers only for disjoint surfaces with explicit path ownership; otherwise run one.
