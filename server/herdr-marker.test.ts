import { expect, it } from "bun:test";
import { markerPid, staleMarker, tasklistImage } from "./herdr-marker.ts";

it("reads the pid out of herdr's Windows socket marker", () => {
  expect(markerPid("4312:133712345678901234")).toBe(4312);
  expect(markerPid("")).toBeNull();
  expect(markerPid("0:1")).toBeNull();
  expect(markerPid("abc:1")).toBeNull();
});

it("reads the image name tasklist reports, and none from its localized no-match line", () => {
  expect(tasklistImage('"herdr.exe","4312","Console","1","12,345 K"\r\n')).toBe("herdr.exe");
  expect(tasklistImage("INFO: No tasks are running which match the specified criteria.\r\n")).toBeNull();
  expect(tasklistImage("정보: 지정된 조건과 일치하는 작업이 없습니다.\r\n")).toBeNull();
});

it("calls a marker stale when its pid is gone or was handed to another program", () => {
  expect(staleMarker("4312:1", () => null)).toBe(true);
  // the pid is alive again after a reboot, as something else
  expect(staleMarker("4312:1", () => "svchost.exe")).toBe(true);
  expect(staleMarker("4312:1", () => "herdr.exe")).toBe(false);
  expect(staleMarker("4312:1", () => "HERDR.EXE")).toBe(false);
  // unreadable: no proof the daemon is gone
  expect(staleMarker("garbage", () => null)).toBe(false);
});
