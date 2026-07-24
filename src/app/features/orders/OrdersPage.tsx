import { t } from "../../lib/i18n";

export function OrdersPage() {
  return (
    <s-page heading={t("orders.title")}>
      <s-section>
        <s-text>{t("orders.empty")}</s-text>
      </s-section>
    </s-page>
  );
}
