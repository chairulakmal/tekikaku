import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.all("/api/*", (c) => c.json({ error: "not_implemented" }, 501));

app.post("/webhooks/*", (c) => c.json({ error: "not_implemented" }, 501));

export { app };

export default {
  fetch: app.fetch,
  scheduled() {
    // Backfill cron tick lands in weekend 3 (SPEC: build sequence and cut line).
  },
} satisfies ExportedHandler<Env>;
