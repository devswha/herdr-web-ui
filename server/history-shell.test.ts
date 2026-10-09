import { expect, it } from "bun:test";
import { historyShellInputEmpty } from "./history-shell.ts";

it.each(["$ ", "example% ", "sam@box:~/repo$ ", "box repo % ", "❯ ", "old output\n$ \n\n"])(
  "recognizes an empty plain prompt: %j", (screen) => {
    expect(historyShellInputEmpty(screen)).toBeTrue();
  },
);

it.each(["", " ", "$ echo pending", "example% vim", "$ echo '$ '", ">>> ", "password: ", "not a prompt", "$ \ncontinuation"])(
  "leaves draft or unproven input alone: %j", (screen) => {
    expect(historyShellInputEmpty(screen)).toBeFalse();
  },
);
