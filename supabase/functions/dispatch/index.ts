import { adminClient, json, options, requireAdmin } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  try {
    const expected = Deno.env.get("HUB_WEBHOOK_SECRET");
    if (!expected || request.headers.get("x-hub-webhook-secret") !== expected) await requireAdmin(request);
    const { data, error } = await adminClient().rpc("dispatch_pending_tasks", { p_limit: 100 });
    if (error) throw error;
    return json({ dispatched: data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
