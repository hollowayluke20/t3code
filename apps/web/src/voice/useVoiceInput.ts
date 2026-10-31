import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  BrowserVoiceRecorder,
  createBrowserVoiceRecorder,
  releaseVoiceRecorder,
  revokeVoiceRecordingUri,
} from "./browserRecorder";
import { getVoiceTranscriber } from "./transcriberRegistry";

export const VOICE_INPUT_UNAVAILABLE_MESSAGE = "Voice input is not available on this server.";

export type VoiceDraftSelection = {
  readonly start: number;
  readonly end: number;
};

export type VoiceInputSnapshot = VoiceInputState & {
  readonly elapsedSeconds: number;
};

export type VoiceInputSessionOptions = {
  readonly recorder: VoiceRecorder;
  readonly getOwnerKey: () => string;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly requestPermission?: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly readText: () => string | null;
  readonly readSelection: () => VoiceDraftSelection;
  readonly commitText: (text: string, selection: VoiceDraftSelection) => void;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
};

export type VoiceInputOptions = {
  readonly ownerKey: string;
  readonly recorder?: VoiceRecorder;
  readonly getTranscriber?: () => VoiceTranscriber | null;
  readonly requestPermission?: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly readText: () => string | null;
  readonly readSelection: () => VoiceDraftSelection;
  readonly commitText: (text: string, selection: VoiceDraftSelection) => void;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
};

const IDLE_SNAPSHOT: VoiceInputSnapshot = {
  phase: "idle",
  error: null,
  errorAction: null,
  elapsedSeconds: 0,
};

/**
 * The React-facing half of the shared controller. Revision tracking and the draft
 * snapshot live here because the web store only persists text, not a revision.
 */
export class ComposerVoiceInput {
  private readonly options: VoiceInputSessionOptions;
  private readonly controller: VoiceInputController;
  private snapshot: VoiceInputSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private previousText: string | null = null;
  private unsubscribeDraft: (() => void) | null = null;
  private errorOverride: string | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private recordingStartedAt: number | null = null;

  constructor(options: VoiceInputSessionOptions) {
    this.options = options;
    if (options.recorder instanceof BrowserVoiceRecorder) {
      options.recorder.onAutoStop = (status) => this.handleRecorderStatus(status);
    }
    this.controller = new VoiceInputController({
      recorder: options.recorder,
      getTranscriber: options.getTranscriber,
      requestPermission: () => this.requestPermission(),
      configureRecording: async () => undefined,
      releaseRecording: async () => releaseVoiceRecorder(options.recorder),
      deleteRecording: revokeVoiceRecordingUri,
      readDraft: () => this.readDraft(),
      commitDraft: (text, selection) => this.options.commitText(text, selection),
      onStateChange: (state) => this.handleStateChange(state),
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceInputSnapshot => this.snapshot;

  handleRecorderStatus(status: VoiceRecorderStatus): void {
    void this.controller.handleRecorderStatus(status);
  }

  toggle(): Promise<void> {
    const phase = this.controller.currentState.phase;
    if (phase === "recording") return this.controller.stop();
    if (phase === "preparing" || phase === "transcribing") {
      this.cancel();
      return Promise.resolve();
    }

    this.errorOverride = null;
    if (!this.options.getTranscriber()) {
      this.publish({
        phase: "error",
        error: VOICE_INPUT_UNAVAILABLE_MESSAGE,
        errorAction: null,
        elapsedSeconds: 0,
      });
      return Promise.resolve();
    }

    this.subscribeToDraft();
    return this.controller.start();
  }

  cancel(): void {
    this.errorOverride = null;
    this.controller.cancel();
    if (this.controller.currentState.phase === "idle" && this.snapshot.phase !== "idle") {
      this.stopElapsedClock();
      this.unsubscribeFromDraft();
      this.publish(IDLE_SNAPSHOT);
    }
  }

  ownerChanged(): void {
    this.cancel();
  }

  dispose(): void {
    this.stopElapsedClock();
    this.unsubscribeFromDraft();
    this.controller.dispose();
    this.listeners.clear();
  }

  private readDraft(): VoiceDraftSnapshot | null {
    const text = this.options.readText();
    if (text === null) return null;
    return {
      ownerKey: this.options.getOwnerKey(),
      text,
      selection: this.options.readSelection(),
      revision: this.revision,
    };
  }

  private async requestPermission(): Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }> {
    if (this.options.requestPermission) return this.options.requestPermission();
    const recorder = this.options.recorder;
    if (recorder instanceof BrowserVoiceRecorder) {
      const access = await recorder.requestMicrophoneAccess();
      if (!access.granted && access.error) this.errorOverride = access.error.message;
      return { granted: access.granted, canAskAgain: access.canAskAgain };
    }
    return { granted: true, canAskAgain: true };
  }

  private handleStateChange(state: VoiceInputState): void {
    const previousPhase = this.snapshot.phase;
    let elapsedSeconds = this.snapshot.elapsedSeconds;
    if (state.phase !== previousPhase) {
      if (previousPhase === "recording") this.stopElapsedClock();
      if (state.phase === "recording") {
        elapsedSeconds = 0;
        this.startElapsedClock();
      } else {
        elapsedSeconds = 0;
      }
    }

    if (!voiceInputBlocksSubmission(state)) this.unsubscribeFromDraft();
    const error =
      state.phase === "error" && this.errorOverride !== null ? this.errorOverride : state.error;
    if (state.phase !== "error") this.errorOverride = null;
    this.publish({ ...state, error, elapsedSeconds });
  }

  private subscribeToDraft(): void {
    if (this.unsubscribeDraft) return;
    this.previousText = this.options.readText();
    this.unsubscribeDraft = this.options.subscribeToDraftChanges(() => {
      const text = this.options.readText();
      if (text !== this.previousText) {
        this.previousText = text;
        this.revision += 1;
      }
    });
  }

  private unsubscribeFromDraft(): void {
    this.unsubscribeDraft?.();
    this.unsubscribeDraft = null;
    this.previousText = null;
  }

  private startElapsedClock(): void {
    this.stopElapsedClock();
    this.recordingStartedAt = Date.now();
    this.elapsedTimer = setInterval(() => {
      if (this.recordingStartedAt === null) return;
      const elapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.floor((Date.now() - this.recordingStartedAt) / 1_000),
      );
      if (elapsedSeconds !== this.snapshot.elapsedSeconds) {
        this.publish({ ...this.snapshot, elapsedSeconds });
      }
    }, 1_000);
  }

  private stopElapsedClock(): void {
    if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.recordingStartedAt = null;
  }

  private publish(snapshot: VoiceInputSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function createVoiceInputSession(options: VoiceInputSessionOptions): ComposerVoiceInput {
  return new ComposerVoiceInput(options);
}

export function useVoiceInput(options: VoiceInputOptions) {
  const latest = useRef(options);
  // oxlint-disable-next-line react/refs -- async recording callbacks read the composer's current draft adapter
  latest.current = options;

  // oxlint-disable-next-line react/refs -- the first render captures callbacks that read the latest adapter ref
  const [session] = useState(() => {
    const recorder = options.recorder ?? createBrowserVoiceRecorder();
    return createVoiceInputSession({
      recorder,
      getOwnerKey: () => latest.current.ownerKey,
      getTranscriber: () =>
        latest.current.getTranscriber ? latest.current.getTranscriber() : getVoiceTranscriber(),
      readText: () => latest.current.readText(),
      readSelection: () => latest.current.readSelection(),
      commitText: (text, selection) => latest.current.commitText(text, selection),
      subscribeToDraftChanges: (listener) => latest.current.subscribeToDraftChanges(listener),
      ...(options.requestPermission
        ? { requestPermission: () => latest.current.requestPermission!() }
        : {}),
    });
  });

  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const isBusy = voiceInputBlocksSubmission(snapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes the shared controller when the composer unmounts
  useEffect(() => () => session.dispose(), [session]);

  const previousOwnerKey = useRef(options.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels dictation when the composer switches drafts
  useEffect(() => {
    if (previousOwnerKey.current === options.ownerKey) return;
    previousOwnerKey.current = options.ownerKey;
    session.ownerChanged();
  }, [options.ownerKey, session]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape cancels an active dictation
  useEffect(() => {
    if (!isBusy) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      session.cancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isBusy, session]);

  return {
    state: snapshot,
    elapsedSeconds: snapshot.elapsedSeconds,
    isBusy,
    toggle: () => session.toggle(),
    cancel: () => session.cancel(),
  };
}
