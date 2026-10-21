import { describe, expect, it } from "bun:test";
import { adoptLegacyEnv, ovisName } from "./legacy-env.ts";

describe("settings under their names from before the rename", () => {
  it("fill an unset OVIS_* variable", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", HERDR_WEB_UI_REF: "v1.2.3", HERDR_SOCKET: "/s" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("old");
    expect(env["OVIS_REF"]).toBe("v1.2.3");
    // herdr's own variables are not the app's
    expect(Object.keys(env).filter((name) => name.startsWith("OVIS_")).sort()).toEqual(["OVIS_REF", "OVIS_TOKEN"]);
  });

  it("never override a variable set under the new name", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", OVIS_TOKEN: "new" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("new");
  });

  it("map only the app's own prefix", () => {
    expect(ovisName("HERDR_WEB_STATE_DIR")).toBe("OVIS_STATE_DIR");
    expect(ovisName("HERDR_TEST_SESSION")).toBeNull();
  });
});
