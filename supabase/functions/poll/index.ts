import { json, options, userClient } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  try {
    const url = new URL(request.url);
    const waitSeconds = Math.max(0, Math.min(Number(url.searchParams.get("wait") ?? 50), 50));
    const client = userClient(request);
    const deadline = Date.now() + waitSeconds * 1000;
    do {
      const { data, error } = await client.from("tasks").select("*").eq("status", "assigned").order("priority", { ascending: false }).order("created_at").limit(10);
      if (error) throw error;
      if (data?.length) return json({ tasks: data });
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    return json({ tasks: [] });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
