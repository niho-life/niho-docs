import { describe, expect, it } from "vitest";
import { AuthConfigError, resolveAuthMode } from "./config";
import { getAuthProvider } from "./index";
import { STUB_USER_ID } from "./stub";
import { beginNihoLogin, NihoLoginNotImplementedError } from "./niho";

const request = { headers: new Headers() };

describe("resolveAuthMode", () => {
  it("defaults to stub outside production", () => {
    expect(resolveAuthMode({ NODE_ENV: "development" })).toBe("stub");
    expect(resolveAuthMode({ NODE_ENV: "test" })).toBe("stub");
    expect(resolveAuthMode({})).toBe("stub");
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "" })).toBe("stub");
  });

  it("accepts stub and niho explicitly outside production", () => {
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "stub" })).toBe("stub");
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "niho" })).toBe("niho");
  });

  it("requires niho in production and never falls back to stub", () => {
    expect(resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "niho" })).toBe("niho");
    expect(() => resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "stub" })).toThrow(AuthConfigError);
    expect(() => resolveAuthMode({ NODE_ENV: "production" })).toThrow(AuthConfigError);
    expect(() => resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "" })).toThrow(AuthConfigError);
  });

  it("rejects unknown values in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      for (const EDITOR_AUTH_MODE of ["STUB", "none", "off", "niho2"]) {
        expect(() => resolveAuthMode({ NODE_ENV, EDITOR_AUTH_MODE })).toThrow(AuthConfigError);
      }
    }
  });
});

describe("auth providers", () => {
  it("stub returns one fixed synthetic user without cookies or tokens", async () => {
    const provider = getAuthProvider({ NODE_ENV: "development", EDITOR_AUTH_MODE: "stub" });
    expect(provider.mode).toBe("stub");
    const session = await provider.getSession(request);
    expect(session).toEqual({ userId: STUB_USER_ID, mode: "stub" });
    expect(Object.keys(session ?? {}).sort()).toEqual(["mode", "userId"]);
  });

  it("niho is fail-closed until the niho-app contract exists", async () => {
    const provider = getAuthProvider({ NODE_ENV: "production", EDITOR_AUTH_MODE: "niho" });
    expect(provider.mode).toBe("niho");
    const withCookie = { headers: new Headers({ cookie: "session=synthetic" }) };
    expect(await provider.getSession(withCookie)).toBeNull();
    expect(() => beginNihoLogin()).toThrow(NihoLoginNotImplementedError);
  });

  it("refuses to pick a provider in production unless the mode is niho", () => {
    expect(() => getAuthProvider({ NODE_ENV: "production", EDITOR_AUTH_MODE: "stub" })).toThrow(AuthConfigError);
    expect(() => getAuthProvider({ NODE_ENV: "production" })).toThrow(AuthConfigError);
  });
});
