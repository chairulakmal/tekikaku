import { describe, expect, it } from "vitest";

import { app } from "./index";

describe("worker", () => {
  it("responds on the health route", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("rejects unimplemented API routes with 501", async () => {
    const res = await app.request("/api/orders");
    expect(res.status).toBe(501);
  });
});
