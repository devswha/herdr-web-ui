import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertPrefs, CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, quickReplyButtons, sanitizeSettings, terminalTheme } from "./settings.ts";

it("keeps the screen wake lock off until this device explicitly enables it", () => {
  expect(DEFAULT_SETTINGS.keepScreenOn).toBe(false);
  expect(sanitizeSettings({}).keepScreenOn).toBe(false);
  expect(sanitizeSettings({ keepScreenOn: true }).keepScreenOn).toBe(true);
  expect(sanitizeSettings({ keepScreenOn: "true" }).keepScreenOn).toBe(false);
  // the terminal's wheel speed: one report per wheel event unless chosen, whole and bounded
  expect(sanitizeSettings({}).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: 3 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 2.6 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 99 }).terminalWheelSpeed).toBe(10);
  expect(sanitizeSettings({ terminalWheelSpeed: 0 }).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: "3" }).terminalWheelSpeed).toBe(1);
});

it("defaults legacy records to workspace grouping and accepts only supported modes", () => {
  expect(sanitizeSettings({}).sidebarGrouping).toBe("workspace");
  expect(sanitizeSettings({ sidebarGrouping: "workspace" }).sidebarGrouping).toBe("workspace");
  expect(sanitizeSettings({ sidebarGrouping: "directory" }).sidebarGrouping).toBe("directory");
  for (const sidebarGrouping of [null, true, "folder", 1]) {
    expect(sanitizeSettings({ sidebarGrouping }).sidebarGrouping).toBe("workspace");
  }
});

describe("chat font size", () => {
  it("follows the density until one is chosen, and keeps a chosen one within bounds", () => {
    expect(chatFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(chatFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(chatFontSize(sanitizeSettings({ density: "compact", chatFontSize: 17 }))).toBe(17);
    expect(sanitizeSettings({ chatFontSize: 99 }).chatFontSize).toBe(CHAT_FONT_MAX);
    expect(sanitizeSettings({ chatFontSize: 2 }).chatFontSize).toBe(CHAT_FONT_MIN);
    expect(sanitizeSettings({ chatFontSize: 15.6 }).chatFontSize).toBe(16);
    expect(sanitizeSettings({ chatFontSize: "18" }).chatFontSize).toBeNull();
    expect(sanitizeSettings({ terminalFontSize: 15 }).chatFontSize).toBeNull();
  });
});

describe("alert choices", () => {
  it("keep alerts on unless this device turned them off with the bell", () => {
    expect(DEFAULT_SETTINGS.alertsOn).toBe(true);
    expect(sanitizeSettings({}).alertsOn).toBe(true);
    expect(sanitizeSettings({ alertsOn: false }).alertsOn).toBe(false);
    expect(sanitizeSettings({ alertsOn: "no" }).alertsOn).toBe(true);
  });

  it("default to questions and long turns, and drop anything unknown to the default", () => {
    expect(alertPrefs(DEFAULT_SETTINGS)).toEqual({ input: true, done: "long" });
    expect(alertPrefs(sanitizeSettings({ alertInput: false, alertDone: "always" }))).toEqual({ input: false, done: "always" });
    expect(alertPrefs(sanitizeSettings({ alertInput: "no", alertDone: "sometimes" }))).toEqual({ input: true, done: "long" });
  });
});

describe("quick replies", () => {
  it("keep replies as typed, bounded, and show only the ones with something to send", () => {
    expect(quickReplyButtons(DEFAULT_SETTINGS)).toEqual(["continue", "yes", "no", "commit and push", "retry"]);
    // a trailing space is the next word being typed: it stays
    const typed = sanitizeSettings({ quickReplies: ["run the ", "", "  ", 7, "ship it"] });
    expect(typed.quickReplies).toEqual(["run the ", "", "  ", "ship it"]);
    expect(quickReplyButtons(typed)).toEqual(["run the ", "ship it"]);
    const many = sanitizeSettings({ quickReplies: Array.from({ length: 20 }, (_, index) => "x".repeat(300) + index) });
    expect(many.quickReplies).toHaveLength(QUICK_REPLIES_MAX);
    expect(many.quickReplies.every((reply) => reply.length === QUICK_REPLY_MAX_CHARS)).toBe(true);
    // an emptied list is a choice, not a broken record
    expect(sanitizeSettings({ quickReplies: [] }).quickReplies).toEqual([]);
    expect(sanitizeSettings({}).quickReplies).toEqual(DEFAULT_SETTINGS.quickReplies);
  });
});

describe("suggestion chip", () => {
  it("stays off until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showSuggestionChip).toBe(false);
    expect(sanitizeSettings({}).showSuggestionChip).toBe(false);
    expect(sanitizeSettings({ showSuggestionChip: true }).showSuggestionChip).toBe(true);
    expect(sanitizeSettings({ showSuggestionChip: "yes" }).showSuggestionChip).toBe(false);
  });
});

describe("quick replies row", () => {
  it("stays hidden until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showQuickReplies).toBe(false);
    expect(sanitizeSettings({ showQuickReplies: true }).showQuickReplies).toBe(true);
    expect(sanitizeSettings({ showQuickReplies: "yes" }).showQuickReplies).toBe(false);
    expect(DEFAULT_SETTINGS.showUsage).toBe(false);
    expect(sanitizeSettings({ showUsage: true }).showUsage).toBe(true);
    expect(sanitizeSettings({ showUsage: 1 }).showUsage).toBe(false);
    expect(DEFAULT_SETTINGS.usageCount).toBe("used");
    expect(sanitizeSettings({ usageCount: "left" }).usageCount).toBe("left");
    expect(sanitizeSettings({ usageCount: "half" }).usageCount).toBe("used");
    expect(sanitizeSettings({ usageOrder: ["codex:a", 3, "codex:a", "", "claude:b"] }).usageOrder).toEqual(["codex:a", "claude:b"]);
    expect(sanitizeSettings({ usageHidden: Array.from({ length: 100 }, (_, index) => `k${index}`) }).usageHidden).toHaveLength(64);
    expect(sanitizeSettings({ usageHidden: "codex:a" }).usageHidden).toEqual([]);
  });
});

describe("palette", () => {
  it("defaults to amber, the look before this setting, and keeps only a known palette", () => {
    expect(DEFAULT_SETTINGS.palette).toBe("amber");
    // settings stored before palettes existed carry no palette key
    expect(sanitizeSettings({ theme: "light" }).palette).toBe("amber");
    expect(sanitizeSettings({ palette: "report" }).palette).toBe("report");
    expect(sanitizeSettings({ palette: "charcoal" }).palette).toBe("charcoal");
    expect(sanitizeSettings({ palette: "pink" }).palette).toBe("amber");
  });

  const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  const paper = '[data-theme="light"]:is([data-palette="report"], [data-palette="charcoal"])';
  // each case lists its blocks from the most specific to the base; the first one naming a token wins
  const cases = [
    { theme: "dark", palette: "amber", layers: [":root"] },
    { theme: "light", palette: "amber", layers: ['[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "report", layers: ['[data-theme="dark"][data-palette="report"]', ":root"] },
    { theme: "light", palette: "report", layers: [paper, '[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "charcoal", layers: ['[data-theme="dark"][data-palette="charcoal"]', ":root"] },
    { theme: "light", palette: "charcoal", layers: ['[data-theme="light"][data-palette="charcoal"]', paper, '[data-theme="light"]', ":root"] },
  ] as const;
  const tokens = (layers: readonly string[]) => (name: string): string =>
    layers.map((selector) => block(selector).match(new RegExp(`--${name}: ([^;]+);`))?.[1]).find((value) => value !== undefined)!;

  it("mirrors each palette's --term-* tokens of styles.css for xterm", () => {
    for (const { theme, palette, layers } of cases) {
      const read = tokens(layers);
      expect(terminalTheme(theme, palette)).toEqual({ background: read("term-bg"), foreground: read("term-fg"), cursor: read("term-cursor"), selectionBackground: read("term-selection") });
    }
  });

  it("keeps text and agent states readable (WCAG AA 4.5:1) on every surface of every palette", () => {
    type Rgb = [number, number, number];
    const rgba = (value: string): [Rgb, number] => {
      const hex = value.match(/^#([0-9a-f]{6})$/);
      if (hex) return [[0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb, 1];
      const parts = value.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/)!;
      return [[Number(parts[1]), Number(parts[2]), Number(parts[3])], Number(parts[4])];
    };
    const over = (top: string, under: Rgb): Rgb => {
      const [rgb, alpha] = rgba(top);
      return rgb.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
    };
    const luminance = (rgb: Rgb): number => {
      const [r, g, b] = rgb.map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)) as Rgb;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: Rgb, b: Rgb): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const failures: string[] = [];
    for (const { theme, palette, layers } of cases) {
      const read = tokens(layers);
      const color = (name: string): Rgb => rgba(read(name))[0];
      for (const surface of ["bg", "bg-panel", "bg-elevated", "bg-hover"]) {
        for (const text of ["text", "text-dim"]) {
          if (ratio(color(text), color(surface)) < 4.5) failures.push(`${theme}/${palette} ${text} on ${surface}`);
        }
        // a status badge: its color on its tint, over a (hovered or selected) row
        for (const state of ["working", "blocked", "done"]) {
          const backdrop = over(read(`status-${state}-tint`), color(surface));
          if (ratio(color(`status-${state}`), backdrop) < 4.5) failures.push(`${theme}/${palette} ${state} badge on ${surface}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("paints amber before settings load: the base blocks are the default palette's", () => {
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    expect(root).toContain(`--term-bg: ${terminalTheme("dark").background};`);
    expect(root).toContain(`--term-cursor: ${terminalTheme("dark").cursor};`);
    expect(terminalTheme("dark")).toEqual(terminalTheme("dark", "amber"));
  });
});

describe("agent marks", () => {
  it("drops the icon choice 0.3.36 stored, so every pane shows its provider logo", () => {
    const settings = sanitizeSettings({ claudeMark: "mascot", codexMark: "app" });
    expect(settings).not.toHaveProperty("claudeMark");
    expect(settings).not.toHaveProperty("codexMark");
  });
});

describe("plan meter placement", () => {
  it("sits beside Settings until the top of the list is chosen", () => {
    expect(DEFAULT_SETTINGS.usagePlacement).toBe("footer");
    expect(sanitizeSettings({ usagePlacement: "top" }).usagePlacement).toBe("top");
    expect(sanitizeSettings({ usagePlacement: "left" }).usagePlacement).toBe("footer");
  });
});
