# WeChat adapter boundary

`supabase/functions/wechat-in` accepts a normalized JSON webhook:

```json
{ "message_id": "unique-message-id", "text": "@agent-name do the task" }
```

The caller must send `x-channel-secret`. `source_msg_id` provides idempotency. `wechat-out` forwards normalized event payloads only when `WECHAT_OUT_WEBHOOK_URL` is configured.

The current WeChat iLink bridge is poll-based rather than webhook-based, so production integration remains disabled by default. Use the Web task form as the simulator; deleting this directory and the two optional functions does not affect scheduling or workers.
