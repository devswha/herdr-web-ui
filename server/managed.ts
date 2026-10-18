/** Run the operator-built checkout. Builds and software updates are separate deployment steps. */
import { fileURLToPath } from "node:url";

if (import.meta.main) {
  const child = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, HERDR_WEB_MANAGED: "1" },
    // The server shuts down on IPC disconnect if its launcher unexpectedly exits.
    ipc() {},
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.exit(await child.exited);
}
