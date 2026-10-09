import { useT } from "../lib/i18n.ts";
import "./SessionBadge.css";

/** Identity, not a key binding: it matches the same session in every surface. */
export function SessionBadge({ number }: { readonly number: number | undefined }) {
  const t = useT();
  return number === undefined ? null : <span className="session-badge" aria-label={t("View {number}", { number })}>#{number}</span>;
}
