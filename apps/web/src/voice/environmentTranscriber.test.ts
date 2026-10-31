import { VoiceTranscribeError, type VoiceTranscribeInput } from "@t3tools/contracts";
import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createEnvironmentVoiceTranscriber,
  type EnvironmentVoiceTranscribe,
} from "./environmentTranscriber";

const blobUrls: string[] = [];

function wavBlobUrl(bytes: Uint8Array): string {
  const uri = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }));
  blobUrls.push(uri);
  return uri;
}

function fakeRecording(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  for (let index = 12; index < bytes.length; index += 1) bytes[index] = index % 251;
  return bytes;
}

afterEach(() => {
  for (const uri of blobUrls) URL.revokeObjectURL(uri);
  blobUrls.length = 0;
});

describe("environment voice transcriber", () => {
  it("base64 round-trips a 3 MB recording through the RPC", async () => {
    const audio = fakeRecording(3 * 1024 * 1024);
    const inputs: VoiceTranscribeInput[] = [];
    const transcriber = createEnvironmentVoiceTranscriber(async (input) => {
      inputs.push(input);
      return { text: "hello world", durationMs: 1_200, model: "test-model" };
    });
    const signal = new AbortController().signal;

    const prepared = await transcriber.prepare({ signal });
    expect(prepared.locale).toBe("en-US");
    await expect(prepared.transcribe(wavBlobUrl(audio), { signal })).resolves.toBe("hello world");

    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input.mimeType).toBe("audio/wav");
    expect(input.language).toBe("en");
    expect(Buffer.from(input.audioBase64, "base64").equals(Buffer.from(audio))).toBe(true);
  });

  it.each([
    ["unavailable", "Voice transcription is unavailable: set T3CODE_WHISPER_MODEL.", "unavailable"],
    ["failed", "Whisper exited with status 1.", "transcription-failed"],
    ["invalid-audio", "Audio payload is empty.", "transcription-failed"],
    ["too-large", "Audio payload exceeds the limit.", "transcription-failed"],
  ] as const)("maps the %s reason (%s) to the %s code", async (reason, message, code) => {
    const transcriber = createEnvironmentVoiceTranscriber(async () => {
      throw new VoiceTranscribeError({ reason, message });
    });
    const signal = new AbortController().signal;
    const prepared = await transcriber.prepare({ signal });

    await expect(
      prepared.transcribe(wavBlobUrl(fakeRecording(64)), { signal }),
    ).rejects.toMatchObject({ code, message });
  });

  it("reports an older server without the method as unavailable", async () => {
    const transcriber = createEnvironmentVoiceTranscriber(async () => {
      throw new Error("RpcClientDefect: Unknown request tag: voice.transcribe");
    });
    const signal = new AbortController().signal;
    const prepared = await transcriber.prepare({ signal });

    await expect(
      prepared.transcribe(wavBlobUrl(fakeRecording(64)), { signal }),
    ).rejects.toMatchObject({
      name: "VoiceTranscriptionError",
      code: "unavailable",
      message: "This server does not support voice input. Update the server.",
    });
  });

  it("reports cancellation when the signal aborts before transcription", async () => {
    const transcriber = createEnvironmentVoiceTranscriber(async () => ({
      text: "late",
      durationMs: 0,
      model: "test-model",
    }));
    const controller = new AbortController();
    const prepared = await transcriber.prepare({ signal: controller.signal });
    controller.abort();

    const error = await prepared
      .transcribe(wavBlobUrl(fakeRecording(64)), { signal: controller.signal })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
  });

  it("reports cancellation when the signal aborts while the RPC is running", async () => {
    const controller = new AbortController();
    const callTranscribe: EnvironmentVoiceTranscribe = async () => {
      controller.abort();
      return { text: "late", durationMs: 0, model: "test-model" };
    };
    const prepared = await createEnvironmentVoiceTranscriber(callTranscribe).prepare({
      signal: controller.signal,
    });

    await expect(
      prepared.transcribe(wavBlobUrl(fakeRecording(64)), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
