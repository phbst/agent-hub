import { adminClient, errorMessage, json, options, randomSecret, requireAdmin, sha256 } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  try {
    const administrator = await requireAdmin(request);
    const body = await request.json();
    const client = adminClient();
    if (body.action === "bootstrap") {
      const token = randomSecret();
      const expiresAt = new Date(Date.now() + Math.max(5, Math.min(Number(body.minutes ?? 60), 1440)) * 60_000).toISOString();
      const uses = Math.max(1, Math.min(Number(body.uses ?? 1), 100));
      const { error } = await client.from("bootstrap_tokens").insert({
        token_hash: await sha256(token), expires_at: expiresAt, uses_remaining: uses, created_by: administrator.id,
      });
      if (error) throw error;
      return json({ token, expires_at: expiresAt, uses });
    }
    if (body.action === "approve") {
      const { error } = await client.from("agents").update({ status: "online", last_heartbeat: new Date().toISOString() }).eq("id", body.agent_id).eq("status", "pending_approval").select("id").single();
      if (error) throw error;
      await client.rpc("dispatch_pending_tasks", { p_limit: 100 });
      return json({ approved: true });
    }
    if (body.action === "revoke") {
      const { data: agent, error: readError } = await client.from("agents").select("auth_user_id").eq("id", body.agent_id).single();
      if (readError) throw readError;
      if (agent.auth_user_id) await client.auth.admin.updateUserById(agent.auth_user_id, { ban_duration: "876000h" });
      const { error } = await client.from("agents").update({ status: "revoked" }).eq("id", body.agent_id).select("id").single();
      if (error) throw error;
      return json({ revoked: true });
    }
    if (body.action === "remove") {
      const { data: agent, error: readError } = await client.from("agents").select("auth_user_id,status,name").eq("id", body.agent_id).single();
      if (readError) throw readError;
      if (agent.status !== "revoked") return json({ error: "只能删除已吊销的 agent,请先吊销" }, 400);
      if (agent.auth_user_id) await client.auth.admin.deleteUser(agent.auth_user_id);
      const { error } = await client.from("agents").delete().eq("id", body.agent_id);
      if (error) throw error;
      return json({ removed: true, name: agent.name });
    }
    return json({ error: "unknown action" }, 400);
  } catch (error) {
    return json({ error: errorMessage(error) }, 401);
  }
});
