/** Release scenarios are optional until readable fork releases exist. Current-commit QA is not. */
import { appendFileSync } from "node:fs";
import { APP_TAG_PREFIX, DISTRIBUTION_GIT } from "../shared/distribution.ts";

export function forkReleasePrerequisites(refs: string | null): { latest: string; previous: string; reason: string } {
  if (refs === null) return { latest: "", previous: "", reason: "Fork source is not readable with this run's Git credentials." };
  const tags = [...new Set([...refs.matchAll(/refs\/tags\/(fork-v\d+\.\d+\.\d+)$/gm)].map((match) => match[1]!))];
  tags.sort((left, right) => {
    const a = left.slice(APP_TAG_PREFIX.length).split(".").map(Number);
    const b = right.slice(APP_TAG_PREFIX.length).split(".").map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  });
  return { latest: tags.at(-1) ?? "", previous: tags.at(-2) ?? "", reason: tags.length === 0
    ? "No stable fork release exists yet; latest and previous-release scenarios are skipped."
    : tags.length === 1 ? "Only one stable fork release exists; previous-release update is skipped." : "Two readable fork releases are available." };
}

if (import.meta.main) {
  const read = Bun.spawnSync(["git", "ls-remote", "--tags", "--refs", DISTRIBUTION_GIT, `${APP_TAG_PREFIX}*`], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 30_000, stdout: "pipe", stderr: "pipe",
  });
  const result = forkReleasePrerequisites(read.exitCode === 0 ? read.stdout.toString().replace(/\r\n/g, "\n") : null);
  console.log(result.reason);
  if (!result.latest || !result.previous) console.log(`::notice::Release prerequisites: ${result.reason} Skips do not exercise release installation.`);
  if (!process.env["GITHUB_OUTPUT"]) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env["GITHUB_OUTPUT"], `latest=${result.latest}\nprevious=${result.previous}\n`);
}
