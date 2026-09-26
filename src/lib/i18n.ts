/**
 * UI text in the user's language. The English string is the key: `t("Rename pane")`,
 * `t("Worked for {duration}", { duration })`. A key the Korean dictionary (i18n.ko.ts) lacks
 * comes back in English, so a new string is never blank, and src/lib/i18n.test.ts scans the
 * code for every `t("…")` and fails when one is missing from the dictionary.
 *
 * Components take `t` from `useT()`, whose identity changes with the language so memoized
 * work is redone. Helpers outside React (status labels, shortcut labels, work summaries)
 * call the module-level `t`, which reads the language the SettingsProvider last set.
 */
import { useMemo } from "react";
import { KO } from "./i18n.ko.ts";
import { useSettings } from "./settings.ts";

export type LanguageSetting = "system" | "en" | "ko";
export type Language = "en" | "ko";

export const LANGUAGE_NAMES: Record<LanguageSetting, string> = { system: "System", en: "English", ko: "한국어" };

/** `system` follows the browser: any Korean locale in its list picks Korean. */
export function resolveLanguage(setting: LanguageSetting, languages: readonly string[] = typeof navigator !== "undefined" ? navigator.languages : []): Language {
  if (setting !== "system") return setting;
  return languages.some((tag) => /^ko\b/i.test(tag)) ? "ko" : "en";
}

let current: Language = "en";

export function setCurrentLanguage(language: Language): void {
  current = language;
}

export function currentLanguage(): Language {
  return current;
}

export type Vars = Record<string, string | number>;

/** The text for `key` in `language`, placeholders filled; pure, for tests and for both `t`s. */
export function translate(language: Language, key: string, vars?: Vars): string {
  const text = language === "ko" ? KO[key] ?? key : key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function t(key: string, vars?: Vars): string {
  return translate(current, key, vars);
}

export type Translate = (key: string, vars?: Vars) => string;

/** `t` bound to the current language, a new function whenever the language changes. */
export function useT(): Translate {
  const { resolvedLanguage } = useSettings();
  return useMemo<Translate>(() => (key, vars) => translate(resolvedLanguage, key, vars), [resolvedLanguage]);
}

/** The BCP 47 tag for Intl formatting in the current language. */
export function useLocale(): string {
  const { resolvedLanguage } = useSettings();
  return resolvedLanguage === "ko" ? "ko-KR" : "en-US";
}
