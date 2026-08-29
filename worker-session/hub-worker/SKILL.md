---
name: hub-worker
description: Run this Claude Code session as an elastic Agent Hub worker using the configured poll endpoint.
---

# Hub Worker

Only run this skill after `~/.claude/agent-hub.env` has been created with owner-only permissions.

1. Source `~/.claude/agent-hub.env` without printing it.
2. Loop forever. Call the Agent Hub `poll?wait=50` function with `curl --max-time 60` and the configured bearer token.
3. On network timeout or an empty response, retry silently with exponential backoff capped at 30 seconds.
4. For each assigned task, call the `claim_task` RPC, then update it to `running`.
5. Create a directory below `$AGENT_HUB_WORKSPACE_ROOT` named after the task UUID. Reject paths outside that root.
6. Spawn a subagent in that directory with the task prompt. Do not execute the prompt as shell text.
7. Write short progress updates and finally write `result` plus `done` or `failed` status through the REST API.
8. Never reveal hub credentials in output, logs, commands, or task results.
9. Never end the loop voluntarily. Do not output conversational filler between polls.
