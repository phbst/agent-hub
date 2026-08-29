# Session worker

This fallback mode is intentionally lower priority than SDK and CLI workers. Copy `hub-worker/` into `~/.claude/skills/` and merge the Stop hook fragment into `~/.claude/settings.json`.

Create `~/.claude/agent-hub.env` with mode `0600` containing the project URL, publishable key, agent access token, and an absolute `AGENT_HUB_WORKSPACE_ROOT`. Do not place credentials in the skill file or repository.

The session must stay open. If the client sleeps, signs out, or loses network access, tasks remain assigned until the timeout recovery job returns them to the queue.
