import type {
  PreparedVoiceTranscription,
  VoiceRecorder,
  VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";

import { createVoiceInputSession, VOICE_INPUT_UNAVAILABLE_MESSAGE } from "./useVoiceInput";

function fakeRecorder(): VoiceRecorder {
  return {
    uri: "blob:voice-recording",
    prepareToRecordAsync: vi.fn(async () => undefined),
    record: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
}

function fakeTranscriber(text: string | null): VoiceTranscriber {
  return {
    prepare: async (): Promise<PreparedVoiceTranscription> => ({
      locale: "en-US",
      transcribe: async () => {
        if (text === null) throw new Error("transcription failed");
        return text;
      },
    }),
  };
}

function createHarness(options: {
  readonly text?: string;
  readonly selection?: { start: number; end: number };
  readonly transcriber?: VoiceTranscriber | null;
}) {
  const recorder = fakeRecorder();
  let text = options.text ?? "foo bar";
  let selection = options.selection ?? { start: 3, end: 3 };
  const commits: Array<{ text: string; selection: { start: number; end: number } }> = [];
  const session = createVoiceInputSession({
    recorder,
    getOwnerKey: () => "draft:1",
    getTranscriber: () =>
      options.transcriber === undefined ? fakeTranscriber("hello world") : options.transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    readText: () => text,
    readSelection: () => selection,
    commitText: (nextText, nextSelection) => {
      text = nextText;
      selection = nextSelection;
      commits.push({ text: nextText, selection: nextSelection });
    },
    subscribeToDraftChanges: () => () => undefined,
  });
  return {
    session,
    recorder,
    commits,
    text: () => text,
    selection: () => selection,
    [Symbol.dispose]: () => session.dispose(),
  };
}

describe("composer voice input", () => {
  it("inserts the transcript at the captured cursor through the shared controller", async () => {
    using harness = createHarness({ text: "foo bar", selection: { start: 3, end: 3 } });

    await harness.session.toggle();
    expect(harness.session.getSnapshot().phase).toBe("recording");

    await harness.session.toggle();

    expect(harness.text()).toBe("foo hello world bar");
    expect(harness.selection()).toEqual({ start: 15, end: 15 });
    expect(harness.commits).toEqual([
      { text: "foo hello world bar", selection: { start: 15, end: 15 } },
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  });

  it("replaces the captured selection instead of inserting around it", async () => {
    using harness = createHarness({ text: "foo bar", selection: { start: 4, end: 7 } });

    await harness.session.toggle();
    await harness.session.toggle();

    expect(harness.text()).toBe("foo hello world");
  });

  it("surfaces a clear error instead of recording when no transcriber is registered", async () => {
    using harness = createHarness({ transcriber: null });

    await harness.session.toggle();

    expect(harness.session.getSnapshot()).toMatchObject({
      phase: "error",
      error: VOICE_INPUT_UNAVAILABLE_MESSAGE,
    });
    expect(harness.recorder.record).not.toHaveBeenCalled();
  });

  it("cancels without committing a transcript", async () => {
    using harness = createHarness({});

    await harness.session.toggle();
    harness.session.cancel();

    expect(harness.session.getSnapshot().phase).toBe("idle");
    expect(harness.commits).toEqual([]);
    expect(harness.recorder.stop).toHaveBeenCalled();
  });
});
