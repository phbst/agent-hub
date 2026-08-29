import { describe, expect, it } from "vitest";
import { isSessionAuthorizationError } from "../worker-cli/src/worker.js";

describe("worker authentication recovery", () => {
  it("recognizes expired-session authorization failures", () => {
    expect(isSessionAuthorizationError({ code: "42501", message: "permission denied for function agent_heartbeat" })).toBe(true);
    expect(isSessionAuthorizationError({ code: "PGRST301", message: "JWT expired" })).toBe(true);
  });

  it("does not retry ordinary database failures as authentication failures", () => {
    expect(isSessionAuthorizationError({ code: "23505", message: "duplicate key" })).toBe(false);
  });
});
