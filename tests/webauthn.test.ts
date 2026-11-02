import { afterEach, expect, spyOn, test } from "bun:test";
import { passkeyContext } from "../src/lib/access/passkeys";
import { AccessService } from "../src/lib/access/service";
import { adb } from "../src/lib/access/db";

const originalOrigins = process.env.WEBAUTHN_ORIGINS;
afterEach(() => {
  if (originalOrigins === undefined) delete process.env.WEBAUTHN_ORIGINS;
  else process.env.WEBAUTHN_ORIGINS = originalOrigins;
});

test("passkey ceremonies bind the exact configured origin and hostname", () => {
  process.env.WEBAUTHN_ORIGINS = "https://workspace.example,http://localhost:9081";
  expect(passkeyContext("https://workspace.example")).toEqual({ origin: "https://workspace.example", rpId: "workspace.example" });
  expect(passkeyContext("http://localhost:9081")).toEqual({ origin: "http://localhost:9081", rpId: "localhost" });
  for (const origin of [
    "https://workspace.example.evil.test", "https://evil.test", "https://workspace.example:9443",
    "https://workspace.example/path", "https://user@workspace.example", "http://workspace.example",
  ]) expect(() => passkeyContext(origin)).toThrow();
});

test("bootstrap reset cannot remove an enrolled administrator's passkey protection", async () => {
  const service = new AccessService();
  const config = spyOn(service, "getConfig").mockResolvedValue({ userHash: "test", adminHash: "test", setupHash: null, templateKey: Buffer.alloc(32), secret: "test-secret" });
  const throttle = spyOn(service, "throttle").mockResolvedValue(undefined);
  const count = spyOn(adb.accessUser, "count").mockResolvedValue(1);
  try {
    expect((await service.handle("reset", { adminPassword: "example-password" }, {}, "test")).status).toBe(403);
  } finally {
    config.mockRestore();
    throttle.mockRestore();
    count.mockRestore();
  }
});