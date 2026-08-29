import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key && !url.includes("PROJECT_REF") && !key.includes("REPLACE_ME"));
export const supabase = createClient(url ?? "https://invalid.supabase.co", key ?? "missing", {
  auth: { persistSession: true, detectSessionInUrl: true },
});
