// Lightweight key-based dictionary; no i18n framework by design (SPEC: feature list item 9).
const ja = {
  "orders.title": "注文",
  "orders.empty": "注文はまだありません",
} as const;

export type MessageKey = keyof typeof ja;
export type Locale = "ja" | "en";

const en: Record<MessageKey, string> = {
  "orders.title": "Orders",
  "orders.empty": "No orders yet",
};

let locale: Locale = "ja";

export function setLocale(next: Locale): void {
  locale = next;
}

export function t(key: MessageKey): string {
  return locale === "ja" ? ja[key] : en[key];
}
