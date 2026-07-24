---
description: Summarize this conversation and save to memory
model: openai/gpt-5.6-luna
---

<amnesia_sum_command>
Summarize this conversation and save it to memory.

## Instructions

1. **Analyze the conversation** above this message.

2. **Generate a summary** in markdown:

```markdown
## Summary
[2-3 paragraph summary of what was discussed and decided]

## Key Topics
- [Topic 1]
- [Topic 2]

## Technical Details
[Important technical information, code patterns, or solutions]

## Code Changes
[Files modified with brief descriptions, or "None" if no changes]

## Outcome
[Result of the conversation - was the problem solved?]
```

3. **Choose 3-5 tags** from: golang, python, typescript, javascript, bash, docker, kubernetes, git, database, api, testing, debugging, refactoring, performance, security, config, devops, cli, documentation, bug-fix, feature

4. **Save** by piping your summary to this command:

```bash
cat << 'EOF' | ~/.config/opencode/skills/amnesia/save.py save --tags "tag1,tag2,tag3"
YOUR_SUMMARY_HERE
EOF
```

5. **Report** the result to the user.
</amnesia_sum_command>
