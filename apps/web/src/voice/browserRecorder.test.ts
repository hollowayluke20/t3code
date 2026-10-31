import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserVoiceRecorder } from "./browserRecorder";

function stubMediaDevices(getUserMedia: MediaDevices["getUserMedia"]): void {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserVoiceRecorder microphone access", () => {
  it("explains that the microphone needs HTTPS or localhost when getUserMedia is missing", async () => {
    vi.stubGlobal("navigator", {});

    const access = await new BrowserVoiceRecorder().requestMicrophoneAccess();

    expect(access).toMatchObject({ granted: false, canAskAgain: false });
    expect(access.error?.code).toBe("microphone-unavailable");
    expect(access.error?.message).toContain("HTTPS or localhost");
  });

  it("points a denied permission at the browser or site settings", async () => {
    stubMediaDevices(
      vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    );

    const access = await new BrowserVoiceRecorder().requestMicrophoneAccess();

    expect(access).toMatchObject({ granted: false, canAskAgain: true });
    expect(access.error?.code).toBe("permission-denied");
    expect(access.error?.message).toContain("browser or site settings");
  });

  it("reports a missing device separately from a denied permission", async () => {
    stubMediaDevices(
      vi.fn(async () => {
        throw new DOMException("missing", "NotFoundError");
      }),
    );

    const access = await new BrowserVoiceRecorder().requestMicrophoneAccess();

    expect(access).toMatchObject({ granted: false, canAskAgain: true });
    expect(access.error?.code).toBe("no-device");
    expect(access.error?.message).toContain("No microphone was found");
  });
});
