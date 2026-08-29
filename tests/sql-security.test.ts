import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL("../supabase/migrations/202608280001_agent_hub.sql", import.meta.url);

describe("database security migration", () => {
  it("enables RLS, removes anonymous grants, and protects definer functions", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const table of ["bootstrap_tokens", "agents", "tasks", "events"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("revoke all on public.bootstrap_tokens");
    expect(sql).toContain("revoke execute on function public.is_hub_admin()");
    expect(sql).toContain("assigned_to = public.current_agent_id()");
  });
});
