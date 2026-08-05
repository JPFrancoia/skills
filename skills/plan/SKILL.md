---
name: plan
description: Create and maintain durable implementation plans. Use before non-trivial implementation work that spans multiple files, changes architecture or risky behavior, or has unresolved requirements.
---

# Implementation Planning

Use this skill before you implement non-trivial work.

Do not create a plan for:

- one-line fixes
- simple configuration changes
- typo fixes
- direct answers
- read-only analysis
- routine command execution

## Create the plan

1. Save the plan as `plans/<topic>-plan.md` in the project root.
2. Use a descriptive topic name.
3. Create the `plans/` directory when it does not exist.
4. Make the initial plan exploratory when the codebase has unresolved facts.
5. Before implementation, make the plan implementation-ready.
6. Present the plan path and a concise, high-signal summary.
7. Wait for user approval before implementation.

Do not write only a checklist.

## Required sections

Include these sections unless the work is trivial:

1. Brief
2. Current state / relevant context
3. Proposed implementation
4. File-by-file impact
5. Risks and edge cases
6. Validation / testing
7. Step-by-step execution checklist
8. Open questions / assumptions

## Plan quality

- Be concise in wording, but cover the required details.
- Name likely files, modules, systems, and interfaces when you can infer them.
- State important tradeoffs and the preferred choice.
- State uncertain details as assumptions.
- Explain the Brief in plain English in two to four sentences.
- State what changes and why the work is necessary now.
- Do not use the Brief for implementation steps, task history, or generic goals.

When you present the plan, summarize:

- the Brief
- major implementation decisions
- likely files or systems affected
- key risks and tradeoffs
- validation approach
- open questions and assumptions

## Maintain the plan

- Update the plan when implementation changes material decisions or details.
- Mark completed checklist steps as work finishes.
- Record deviations and the reason for each deviation.
- Keep completed plans as decision records.
- Mark a completed plan with the completion date.
- Never delete a plan.

## Plan review

For genuinely non-trivial planning work, offer the `grill` skill. Use it to challenge the plan against project documentation, terminology, and existing decisions before implementation.
