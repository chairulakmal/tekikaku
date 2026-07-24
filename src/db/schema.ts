import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// All money columns are integer yen (SPEC: data model sketch). No JSONB or other
// Postgres-only features anywhere in this schema (D1 escape hatch).

export const shops = pgTable("shops", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shopDomain: text("shop_domain").notNull().unique(),
  accessToken: text("access_token"),
  locale: text("locale", { enum: ["ja", "en"] })
    .notNull()
    .default("ja"),
  installedAt: timestamp("installed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
});

export const settings = pgTable("settings", {
  shopId: integer("shop_id")
    .primaryKey()
    .references(() => shops.id),
  // 登録番号: T + 13 digits, validated at the API boundary (SPEC: feature list item 2).
  registrationNumber: text("registration_number"),
  sellerName: text("seller_name"),
  sellerAddress: text("seller_address"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV-"),
  roundingMode: text("rounding_mode", { enum: ["floor", "half_up", "ceil"] })
    .notNull()
    .default("floor"),
});

// Gap-free numbering: incremented via single-statement UPDATE ... RETURNING inside
// the issue transaction (SPEC: invoice numbering transactional boundary).
export const invoiceCounters = pgTable("invoice_counters", {
  shopId: integer("shop_id")
    .primaryKey()
    .references(() => shops.id),
  nextNumber: integer("next_number").notNull().default(1),
});

export const orders = pgTable(
  "orders",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    shopId: integer("shop_id")
      .notNull()
      .references(() => shops.id),
    shopifyOrderId: text("shopify_order_id").notNull(),
    orderName: text("order_name").notNull(),
    buyerName: text("buyer_name"),
    currency: text("currency").notNull(),
    totalAmount: integer("total_amount").notNull(),
    taxesIncluded: boolean("taxes_included").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    ingestedVia: text("ingested_via", {
      enum: ["webhook", "backfill"],
    }).notNull(),
  },
  (table) => [
    // Backs INSERT ... ON CONFLICT DO NOTHING idempotent ingestion (SPEC: query performance).
    uniqueIndex("orders_shop_shopify_order_uq").on(
      table.shopId,
      table.shopifyOrderId,
    ),
    // Composite index supporting keyset pagination on the order list (SPEC: query performance).
    index("orders_shop_placed_id_idx").on(
      table.shopId,
      table.placedAt,
      table.id,
    ),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    shopifyLineItemId: text("shopify_line_item_id").notNull(),
    title: text("title").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    // Basis points: 800 = 8% (軽減税率), 1000 = 10%.
    taxRate: integer("tax_rate").notNull(),
    isReducedRate: boolean("is_reduced_rate").notNull(),
  },
  (table) => [index("order_lines_order_idx").on(table.orderId)],
);

// Rows are immutable after issue: corrections are void + reissue via the
// supersedes chain, never UPDATE (SPEC: data model sketch).
export const invoices = pgTable(
  "invoices",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    shopId: integer("shop_id")
      .notNull()
      .references(() => shops.id),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    number: integer("number").notNull(),
    docType: text("doc_type", { enum: ["invoice", "credit_note"] }).notNull(),
    status: text("status", { enum: ["issued", "voided"] }).notNull(),
    recipientName: text("recipient_name").notNull(),
    issueDate: date("issue_date").notNull(),
    // Per-rate totals are computed once at issue time and stored; list and detail
    // views never re-aggregate line items (SPEC: query performance).
    taxable8: integer("taxable_8").notNull(),
    tax8: integer("tax_8").notNull(),
    taxable10: integer("taxable_10").notNull(),
    tax10: integer("tax_10").notNull(),
    total: integer("total").notNull(),
    roundingModeUsed: text("rounding_mode_used", {
      enum: ["floor", "half_up", "ceil"],
    }).notNull(),
    supersedesInvoiceId: integer("supersedes_invoice_id").references(
      (): AnyPgColumn => invoices.id,
    ),
    originalInvoiceId: integer("original_invoice_id").references(
      (): AnyPgColumn => invoices.id,
    ),
    refundShopifyId: text("refund_shopify_id"),
    r2Key: text("r2_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (table) => [
    uniqueIndex("invoices_shop_number_uq").on(table.shopId, table.number),
    index("invoices_order_idx").on(table.orderId),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    shopId: integer("shop_id")
      .notNull()
      .references(() => shops.id),
    topic: text("topic").notNull(),
    shopifyWebhookId: text("shopify_webhook_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    // Dedupe probe for idempotent webhook delivery (SPEC: query performance).
    uniqueIndex("webhook_events_shopify_id_uq").on(table.shopifyWebhookId),
  ],
);

export const backfillJobs = pgTable("backfill_jobs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shopId: integer("shop_id")
    .notNull()
    .references(() => shops.id),
  status: text("status", { enum: ["pending", "running", "done", "failed"] })
    .notNull()
    .default("pending"),
  dateFrom: date("date_from").notNull(),
  dateTo: date("date_to").notNull(),
  graphqlCursor: text("graphql_cursor"),
  ordersSeen: integer("orders_seen").notNull().default(0),
  invoicesCreated: integer("invoices_created").notNull().default(0),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  error: text("error"),
});
