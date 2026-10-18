import { describe, expect, it } from "bun:test";
import { deviceLabel, isLoopbackHost, phonePlan } from "./phone.ts";

const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317", secure: true };

describe("phonePlan", () => {
  it("shares a non-loopback HTTPS address and guides local clients to configure one", () => {
    expect(phonePlan({ protocol: "https:", hostname: "app.example.test", origin: "https://app.example.test", secure: true })).toEqual({ kind: "here", url: "https://app.example.test" });
    expect(phonePlan(local)).toEqual({ kind: "unknown" });
    expect(phonePlan({ ...local, protocol: "https:" })).toEqual({ kind: "unknown" });
  });
  it("knows loopback names", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    expect(isLoopbackHost("app.example.test")).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("names the device and browser", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36")).toBe("Mac · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", 5)).toBe("iPad · Safari");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36")).toBe("Android · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0")).toBe("Windows · Edge");
    expect(deviceLabel("curl/8.0")).toBe("Device");
  });
});
