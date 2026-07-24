import { defineConfig } from "drizzle-kit";

// drizzle-kit auto-loads .env, so DATABASE_URL decides which database migrations
// hit; failing loud beats drizzle-kit's opaque empty-string connection error.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
});
