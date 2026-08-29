import { adminClient, json, options, randomSecret, sha256, userClient } from "../_shared/http.ts";

async function registrationPassword(token: string, agentId: string): Promise<string> {
  const pepper = Deno.env.get("REGISTRATION_PEPPER");
  if (!pepper) throw new Error("registration service is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${token}:${agentId}`)));
  return `Ah_${btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  try {
    const body = await request.json();
    const client = adminClient();
    if (body.action === "confirm") {
      const { data, error } = await userClient(request).auth.getUser();
      if (error || !data.user) throw new Error("agent authentication required");
      const { error: updateError } = await client.from("agents").update({ registration_confirmed_at: new Date().toISOString() }).eq("auth_user_id", data.user.id);
      if (updateError) throw updateError;
      return json({ confirmed: true });
    }

    const token = String(body.bootstrap_token ?? "");
    const name = String(body.name ?? "");
    if (!token || !name) return json({ error: "bootstrap_token and name are required" }, 400);
    const tokenHash = await sha256(token);
    const { data: bootstrap, error: tokenError } = await client.from("bootstrap_tokens").select("id").eq("token_hash", tokenHash).maybeSingle();
    if (tokenError || !bootstrap) return json({ error: "bootstrap token is invalid" }, 401);

    let { data: agent } = await client.from("agents").select("*").eq("name", name).eq("bootstrap_token_id", bootstrap.id).maybeSingle();
    if (!agent && body.action === "register") {
      const labels = Array.isArray(body.labels) ? body.labels.filter((item: unknown): item is string => typeof item === "string") : [];
      const mode = String(body.mode ?? "");
      const maxConcurrency = Number(body.max_concurrency);
      if (!(["sdk", "cli", "session"] as const).includes(mode as "sdk" | "cli" | "session")) return json({ error: "invalid agent mode" }, 400);
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) return json({ error: "max_concurrency must be an integer from 1 to 32" }, 400);
      const { data: created, error } = await client.rpc("consume_bootstrap_token", {
        p_token_hash: tokenHash,
        p_name: name,
        p_labels: labels,
        p_mode: mode,
        p_max_concurrency: maxConcurrency,
      });
      if (error) throw error;
      agent = Array.isArray(created) ? created[0] : created;
    }
    if (!agent) return json({ error: "registration not found" }, 404);
    if (agent.status === "pending_approval") return json({ status: agent.status, agent_id: agent.id }, 202);
    if (agent.status === "revoked") return json({ status: "revoked" }, 403);
    if (agent.registration_confirmed_at) return json({ status: agent.status, agent_id: agent.id, credentials_confirmed: true });

    const email = `agent-${agent.id}@agent-hub.invalid`;
    const password = await registrationPassword(token, agent.id);
    if (!agent.auth_user_id) {
      const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "agent", agent_id: agent.id } });
      if (error) throw error;
      const { error: linkError } = await client.from("agents").update({ auth_user_id: data.user.id }).eq("id", agent.id);
      if (linkError) throw linkError;
    } else {
      const { error } = await client.auth.admin.updateUserById(agent.auth_user_id, { password });
      if (error) throw error;
    }
    return json({ status: "online", agent_id: agent.id, credentials: { email, password } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
