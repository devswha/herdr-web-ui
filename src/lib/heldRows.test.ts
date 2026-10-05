import { expect, it } from "bun:test";
import { heldCountShown, heldRowsFold, heldRowsHidden, SHORT_PHONE_QUERY } from "./heldRows.ts";

it("the rows fold while a prompt card is open or the phone is short, and at no other time", () => {
  expect(heldRowsFold({ promptOpen: false, shortPhone: false, ready: false })).toBe(false);
  expect(heldRowsFold({ promptOpen: true, shortPhone: false, ready: false })).toBe(true);
  expect(heldRowsFold({ promptOpen: false, shortPhone: true, ready: false })).toBe(true);
  expect(heldRowsFold({ promptOpen: true, shortPhone: true, ready: false })).toBe(true);
});

it("a list that asks for the user's action is never folded", () => {
  expect(heldRowsFold({ promptOpen: false, shortPhone: true, ready: true })).toBe(false);
  expect(heldRowsFold({ promptOpen: true, shortPhone: true, ready: true })).toBe(false);
});

it("folded rows hide until the user opens them, and a row's error opens them", () => {
  expect(heldRowsHidden(true, false, false)).toBe(true);
  expect(heldRowsHidden(true, true, false)).toBe(false);
  expect(heldRowsHidden(true, false, true)).toBe(false);
  // not folded: nothing to open, nothing hidden
  expect(heldRowsHidden(false, false, false)).toBe(false);
  expect(heldRowsHidden(false, true, true)).toBe(false);
});

it("the caption counts from two messages, and a single one only while it can be folded", () => {
  expect(heldCountShown(1, false)).toBe(false);
  expect(heldCountShown(2, false)).toBe(true);
  expect(heldCountShown(3, true)).toBe(true);
  expect(heldCountShown(1, true)).toBe(true);
  expect(heldCountShown(0, true)).toBe(false);
});

it("the short phone is a phone's width with a keyboard's worth of height gone", () => {
  expect(SHORT_PHONE_QUERY).toBe("(max-width: 480px) and (max-height: 600px)");
});
