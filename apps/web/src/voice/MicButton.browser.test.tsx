import type {
  PreparedVoiceTranscription,
  VoiceRecorder,
  VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { MicButton } from "./MicButton";
import { useVoiceInput } from "./useVoiceInput";

function fakeRecorder(): VoiceRecorder {
  return {
    uri: "blob:voice-recording",
    prepareToRecordAsync: vi.fn(async () => undefined),
    record: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
}

function fakeTranscriber(): VoiceTranscriber {
  return {
    prepare: async (): Promise<PreparedVoiceTranscription> => ({
      locale: "en-US",
      transcribe: async () => "hello world",
    }),
  };
}

function Harness(props: {
  readonly recorder: VoiceRecorder;
  readonly transcriber: VoiceTranscriber | null;
}) {
  const [text, setText] = useState("foo bar");
  const voice = useVoiceInput({
    ownerKey: "draft:1",
    recorder: props.recorder,
    getTranscriber: () => props.transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    readText: () => text,
    readSelection: () => ({ start: 3, end: 3 }),
    commitText: (nextText) => setText(nextText),
    subscribeToDraftChanges: () => () => undefined,
  });

  return (
    <div>
      <MicButton
        phase={voice.state.phase}
        error={voice.state.error}
        elapsedSeconds={voice.elapsedSeconds}
        onToggle={() => void voice.toggle()}
      />
      <output aria-label="Draft">{text}</output>
    </div>
  );
}

describe("MicButton", () => {
  it("renders the dictate action and switches to recording when clicked", async () => {
    await using screen = await render(
      <Harness recorder={fakeRecorder()} transcriber={fakeTranscriber()} />,
    );

    const dictate = screen.getByRole("button", { name: "Dictate" });
    await expect.element(dictate).toBeInTheDocument();

    await dictate.click();

    await expect
      .element(screen.getByRole("button", { name: "Stop recording" }))
      .toBeInTheDocument();
    expect(screen.container.querySelector("[data-voice-elapsed]")?.textContent).toBe("0:00");
  });

  it("stops, transcribes, and inserts the text at the cursor", async () => {
    await using screen = await render(
      <Harness recorder={fakeRecorder()} transcriber={fakeTranscriber()} />,
    );

    await screen.getByRole("button", { name: "Dictate" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Stop recording" }))
      .toBeInTheDocument();
    await screen.getByRole("button", { name: "Stop recording" }).click();

    await expect.element(screen.getByLabelText("Draft")).toHaveTextContent("foo hello world bar");
  });

  it("shows the controller error when this server has no transcriber", async () => {
    await using screen = await render(<Harness recorder={fakeRecorder()} transcriber={null} />);

    await screen.getByRole("button", { name: "Dictate" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Voice input is not available on this server.");
  });
});
