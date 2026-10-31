import { describe, expect, it, vi } from "vite-plus/test";
import {
  installMediaPermissionHandlers,
  isAllowedMicrophonePermission,
  type MediaPermissionSystemPreferences,
} from "./MediaPermission.ts";

const appOrigins = ["t3code://app/", "t3code-dev://app/"];

const makeSystemPreferences = (
  status: "not-determined" | "granted" | "denied" = "granted",
): MediaPermissionSystemPreferences => ({
  getMediaAccessStatus: vi.fn(() => status),
  askForMediaAccess: vi.fn(() => Promise.resolve(true)),
});

function install(options: {
  readonly platform?: NodeJS.Platform;
  readonly origins?: readonly string[];
  readonly systemPreferences?: MediaPermissionSystemPreferences;
}) {
  const setPermissionRequestHandler = vi.fn();
  const setPermissionCheckHandler = vi.fn();
  const systemPreferences = options.systemPreferences ?? makeSystemPreferences();
  installMediaPermissionHandlers(
    { setPermissionRequestHandler, setPermissionCheckHandler },
    {
      platform: options.platform ?? "linux",
      appOrigins: options.origins ?? appOrigins,
      systemPreferences,
    },
  );
  return { setPermissionRequestHandler, setPermissionCheckHandler, systemPreferences };
}

const requestHandlerOf = (setPermissionRequestHandler: ReturnType<typeof vi.fn>) =>
  setPermissionRequestHandler.mock.calls[0]?.[0];

const checkHandlerOf = (setPermissionCheckHandler: ReturnType<typeof vi.fn>) =>
  setPermissionCheckHandler.mock.calls[0]?.[0];

const requestPermission = (
  setPermissionRequestHandler: ReturnType<typeof vi.fn>,
  details: object,
) => {
  const handler = requestHandlerOf(setPermissionRequestHandler);
  let granted: boolean | undefined;
  handler(null, "media", (value: boolean) => (granted = value), details);
  return granted;
};

describe("isAllowedMicrophonePermission", () => {
  it("allows audio-only media from the bundled app origins", () => {
    for (const origin of ["t3code://app", "t3code://app/", "t3code-dev://app"]) {
      expect(isAllowedMicrophonePermission(origin, "media", ["audio"], appOrigins)).toBe(true);
    }
    expect(
      isAllowedMicrophonePermission(
        "http://127.0.0.1:5733",
        "media",
        ["audio"],
        [...appOrigins, "http://127.0.0.1:5733/"],
      ),
    ).toBe(true);
  });

  it("denies media from arbitrary websites", () => {
    expect(
      isAllowedMicrophonePermission("https://evil.example", "media", ["audio"], appOrigins),
    ).toBe(false);
    expect(
      isAllowedMicrophonePermission(
        "https://evil.example",
        "media",
        ["audio"],
        [...appOrigins, "https://t3.codes"],
      ),
    ).toBe(false);
  });

  it("denies media requests that include video", () => {
    expect(isAllowedMicrophonePermission("t3code://app", "media", ["video"], appOrigins)).toBe(
      false,
    );
    expect(
      isAllowedMicrophonePermission("t3code://app", "media", ["audio", "video"], appOrigins),
    ).toBe(false);
  });

  it("leaves non-media permissions unchanged (allowed)", () => {
    for (const permission of [
      "notifications",
      "geolocation",
      "openExternal",
      "display-capture",
      "clipboard-read",
      "unknown",
    ]) {
      expect(isAllowedMicrophonePermission("t3code://app", permission, ["audio"], appOrigins)).toBe(
        true,
      );
    }
  });

  it("denies opaque origins and origins outside the app set", () => {
    for (const origin of [
      null,
      undefined,
      "null",
      "",
      "data:text/html,app",
      "blob:t3code://app/0",
    ]) {
      expect(isAllowedMicrophonePermission(origin, "media", ["audio"], appOrigins)).toBe(false);
    }
    expect(
      isAllowedMicrophonePermission("t3code://app", "media", ["audio"], ["t3code-dev://app"]),
    ).toBe(false);
  });
});

describe("media permission handlers", () => {
  it("grants audio-only media from the app origin through both handlers", () => {
    const { setPermissionRequestHandler, setPermissionCheckHandler } = install({});

    expect(
      requestPermission(setPermissionRequestHandler, {
        requestingUrl: "t3code-dev://app/threads/1",
        isMainFrame: true,
        mediaTypes: ["audio"],
      }),
    ).toBe(true);
    expect(
      checkHandlerOf(setPermissionCheckHandler)(null, "media", "t3code-dev://app", {
        mediaType: "audio",
        requestingUrl: "t3code-dev://app/threads/1",
        isMainFrame: true,
      }),
    ).toBe(true);
  });

  it("denies media from arbitrary websites through both handlers", () => {
    const { setPermissionRequestHandler, setPermissionCheckHandler } = install({});

    expect(
      requestPermission(setPermissionRequestHandler, {
        requestingUrl: "https://evil.example/",
        isMainFrame: true,
        mediaTypes: ["audio"],
      }),
    ).toBe(false);
    expect(
      checkHandlerOf(setPermissionCheckHandler)(null, "media", "https://evil.example", {
        mediaType: "audio",
        requestingUrl: "https://evil.example/",
        isMainFrame: true,
      }),
    ).toBe(false);
  });

  it("denies media requests that include video", () => {
    const { setPermissionRequestHandler, setPermissionCheckHandler } = install({});

    expect(
      requestPermission(setPermissionRequestHandler, {
        securityOrigin: "t3code://app",
        requestingUrl: "t3code://app/",
        isMainFrame: true,
        mediaTypes: ["audio", "video"],
      }),
    ).toBe(false);
    expect(
      checkHandlerOf(setPermissionCheckHandler)(null, "media", "t3code://app", {
        mediaType: "video",
        requestingUrl: "t3code://app/",
        isMainFrame: true,
      }),
    ).toBe(false);
  });

  it("leaves non-media permissions unchanged (allowed) through both handlers", () => {
    const { setPermissionRequestHandler, setPermissionCheckHandler } = install({});

    const requestHandler = requestHandlerOf(setPermissionRequestHandler);
    for (const permission of ["notifications", "geolocation", "openExternal"]) {
      let granted: boolean | undefined;
      requestHandler(null, permission, (value: boolean) => (granted = value), {
        requestingUrl: "t3code://app/",
        isMainFrame: true,
      });
      expect(granted).toBe(true);
      expect(
        checkHandlerOf(setPermissionCheckHandler)(null, permission, "t3code://app", {
          requestingUrl: "t3code://app/",
          isMainFrame: true,
        }),
      ).toBe(true);
    }
  });

  it("asks macOS for microphone access when the status is not determined", async () => {
    const systemPreferences = makeSystemPreferences("not-determined");
    const { setPermissionRequestHandler, setPermissionCheckHandler } = install({
      platform: "darwin",
      systemPreferences,
    });

    expect(
      checkHandlerOf(setPermissionCheckHandler)(null, "media", "t3code://app", {
        mediaType: "audio",
        requestingUrl: "t3code://app/",
        isMainFrame: true,
      }),
    ).toBe(false);

    let granted: boolean | undefined;
    requestHandlerOf(setPermissionRequestHandler)(
      null,
      "media",
      (value: boolean) => (granted = value),
      { securityOrigin: "t3code://app", requestingUrl: "t3code://app/", mediaTypes: ["audio"] },
    );
    await Promise.resolve();

    expect(systemPreferences.askForMediaAccess).toHaveBeenCalledTimes(1);
    expect(systemPreferences.askForMediaAccess).toHaveBeenCalledWith("microphone");
    expect(granted).toBe(true);
  });

  it("denies when macOS refuses microphone access", async () => {
    const systemPreferences = makeSystemPreferences("not-determined");
    systemPreferences.askForMediaAccess = vi.fn(() => Promise.resolve(false));
    const { setPermissionRequestHandler } = install({ platform: "darwin", systemPreferences });

    let granted: boolean | undefined;
    requestHandlerOf(setPermissionRequestHandler)(
      null,
      "media",
      (value: boolean) => (granted = value),
      { requestingUrl: "t3code://app/", mediaTypes: ["audio"] },
    );
    await Promise.resolve();

    expect(granted).toBe(false);
  });

  it("does not prompt macOS when access is already denied or granted", () => {
    for (const status of ["denied", "granted"] as const) {
      const systemPreferences = makeSystemPreferences(status);
      const { setPermissionRequestHandler } = install({ platform: "darwin", systemPreferences });

      expect(
        requestPermission(setPermissionRequestHandler, {
          requestingUrl: "t3code://app/",
          mediaTypes: ["audio"],
        }),
      ).toBe(status === "granted");
      expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
    }
  });
});
