import { adminClient, json, options } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  if (!Deno.env.get("WECHAT_CHANNEL_SECRET") || request.headers.get("x-channel-secret") !== Deno.env.get("WECHAT_CHANNEL_SECRET")) {
    return json({ error: "invalid channel secret" }, 401);
  }
  const body = await request.json();
  const text = String(body.text ?? "").trim();
  const directed = text.match(/^(?:让|@)([a-zA-Z][a-zA-Z0-9_-]{1,63})\s+(.*)$/s);
  const prompt = directed?.[2] ?? text;
  const target = directed ? { type: "agent", name: directed[1] } : { type: "auto" };
  const { data, error } = await adminClient().from("tasks").insert({
    title: prompt.slice(0, 80), prompt, source: "wechat", source_msg_id: body.message_id, target,
  }).select("id,status").single();
  if (error) return json({ error: error.message }, error.code === "23505" ? 200 : 400);
  return json(data, 202);
});
