import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { getVoiceTranscriber, setVoiceTranscriber } from "./transcriberRegistry";

const transcriber: VoiceTranscriber = {
  prepare: async () => ({ locale: "en-US", transcribe: async () => "hello" }),
};

afterEach(() => {
  setVoiceTranscriber(null);
});

describe("voice transcriber registry", () => {
  it("starts empty and holds the transcriber a later slice installs", () => {
    expect(getVoiceTranscriber()).toBeNull();

    setVoiceTranscriber(transcriber);
    expect(getVoiceTranscriber()).toBe(transcriber);

    setVoiceTranscriber(null);
    expect(getVoiceTranscriber()).toBeNull();
  });
});
