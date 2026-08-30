import { createClient } from "npm:@supabase/supabase-js@2.112.4";

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  // x-client-info / x-supabase-api-version are always sent by supabase-js in browsers; omitting
  // them fails the preflight and surfaces as "Failed to send a request to the Edge Function".
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version, x-channel-secret, x-hub-webhook-secret",
};

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

export function options(request: Request): Response | null {
  return request.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders }) : null;
}

export function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function userClient(request: Request) {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: request.headers.get("authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new Error("bearer token required");
  return match[1];
}

export async function requireAdmin(request: Request): Promise<{ id: string }> {
  const client = userClient(request);
  const { data, error } = await client.auth.getUser(bearerToken(request));
  if (error || !data.user || data.user.app_metadata?.role !== "admin") throw new Error("admin authentication required");
  return { id: data.user.id };
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomSecret(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
