import { json, options } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  if (request.headers.get("x-hub-webhook-secret") !== Deno.env.get("HUB_WEBHOOK_SECRET")) return json({ error: "unauthorized" }, 401);
  const webhook = Deno.env.get("WECHAT_OUT_WEBHOOK_URL");
  if (!webhook) return json({ skipped: true, reason: "WECHAT_OUT_WEBHOOK_URL is not configured" });
  const body = await request.json();
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: body }),
  });
  return json({ delivered: response.ok }, response.ok ? 200 : 502);
});
