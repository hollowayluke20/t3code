import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

import { encodeVoiceWav } from "./wavEncoder";

export type BrowserVoiceRecorderErrorCode =
  | "microphone-unavailable"
  | "permission-denied"
  | "no-device"
  | "microphone-busy"
  | "recording-failed";

export class BrowserVoiceRecorderError extends Error {
  readonly code: BrowserVoiceRecorderErrorCode;

  constructor(code: BrowserVoiceRecorderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserVoiceRecorderError";
    this.code = code;
  }
}

export type MicrophoneAccessResult = {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  readonly error: BrowserVoiceRecorderError | null;
};

const HTTPS_REQUIRED_MESSAGE =
  "Microphone access needs HTTPS or localhost. Open T3 Code over HTTPS or on localhost to use voice input.";
const PERMISSION_DENIED_MESSAGE =
  "Microphone permission was denied. Allow the microphone in your browser or site settings, then try again.";
const NO_DEVICE_MESSAGE = "No microphone was found. Connect a microphone and try again.";
const MICROPHONE_BUSY_MESSAGE = "The microphone is busy in another app. Close it and try again.";

const PCM_WORKLET_SOURCE = `
class T3PcmCollector extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      const samples = channel.slice();
      this.port.postMessage(samples, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("t3-pcm-collector", T3PcmCollector);
`;

type AudioContextConstructor = new () => AudioContext;
type WebkitWindow = Window & { webkitAudioContext?: AudioContextConstructor };

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as WebkitWindow).webkitAudioContext ?? null;
}

function getUserMedia(): MediaDevices["getUserMedia"] | null {
  if (typeof navigator === "undefined") return null;
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") return null;
  return mediaDevices.getUserMedia.bind(mediaDevices);
}

function mapGetUserMediaError(error: unknown): BrowserVoiceRecorderError {
  const name = error instanceof DOMException ? error.name : null;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new BrowserVoiceRecorderError("permission-denied", PERMISSION_DENIED_MESSAGE, {
        cause: error,
      });
    case "NotFoundError":
    case "DevicesNotFoundError":
      return new BrowserVoiceRecorderError("no-device", NO_DEVICE_MESSAGE, { cause: error });
    case "NotReadableError":
    case "TrackStartError":
      return new BrowserVoiceRecorderError("microphone-busy", MICROPHONE_BUSY_MESSAGE, {
        cause: error,
      });
    default:
      return new BrowserVoiceRecorderError(
        "recording-failed",
        "Could not start the microphone. Check your browser's microphone settings and try again.",
        { cause: error },
      );
  }
}

function liveStream(stream: MediaStream | null): MediaStream | null {
  return stream?.getAudioTracks().some((track) => track.readyState === "live") ? stream : null;
}

export function revokeVoiceRecordingUri(uri: string): void {
  if (!uri.startsWith("blob:")) return;
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(uri);
}

export class BrowserVoiceRecorder implements VoiceRecorder {
  /** Called when the recording limit ends capture without a user stop. */
  onAutoStop: ((status: VoiceRecorderStatus) => void) | null = null;

  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private chunks: Float32Array[] = [];
  private capturing = false;
  private generation = 0;
  private lastUri: string | null = null;

  get uri(): string | null {
    return this.lastUri;
  }

  async requestMicrophoneAccess(): Promise<MicrophoneAccessResult> {
    if (liveStream(this.stream)) {
      return { granted: true, canAskAgain: true, error: null };
    }
    const request = getUserMedia();
    if (!request) {
      return {
        granted: false,
        canAskAgain: false,
        error: new BrowserVoiceRecorderError("microphone-unavailable", HTTPS_REQUIRED_MESSAGE),
      };
    }
    try {
      this.stream = await request({ audio: true });
      return { granted: true, canAskAgain: true, error: null };
    } catch (error) {
      const recorderError = mapGetUserMediaError(error);
      return {
        granted: false,
        canAskAgain:
          recorderError.code === "permission-denied" || recorderError.code === "no-device",
        error: recorderError,
      };
    }
  }

  async prepareToRecordAsync(): Promise<void> {
    const generation = ++this.generation;
    const access = await this.requestMicrophoneAccess();
    if (generation !== this.generation) throw this.cancelledError();
    if (!access.granted || !this.stream) {
      throw (
        access.error ?? new BrowserVoiceRecorderError("recording-failed", HTTPS_REQUIRED_MESSAGE)
      );
    }

    const AudioContextClass = resolveAudioContextConstructor();
    if (!AudioContextClass) {
      throw new BrowserVoiceRecorderError(
        "microphone-unavailable",
        "This browser cannot record audio.",
      );
    }

    this.audioContext = new AudioContextClass();
    await this.audioContext.resume().catch(() => undefined);
    if (generation !== this.generation) throw this.cancelledError();
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(this.audioContext.destination);

    const workletAttached = await this.attachWorklet(generation);
    if (generation !== this.generation) throw this.cancelledError();
    if (!workletAttached && !this.attachScriptProcessor()) {
      this.release();
      throw new BrowserVoiceRecorderError(
        "microphone-unavailable",
        "This browser cannot capture microphone audio.",
      );
    }
  }

  record(options: { readonly forDuration: number }): void {
    if (!this.audioContext || (!this.worklet && !this.processor)) {
      throw new BrowserVoiceRecorderError("recording-failed", "Voice recorder is not prepared.");
    }
    this.chunks = [];
    this.capturing = true;
    if (Number.isFinite(options.forDuration) && options.forDuration > 0) {
      this.autoStopTimer = setTimeout(() => {
        void this.finishAutoStop();
      }, options.forDuration * 1_000);
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    const wasCapturing = this.capturing;
    this.capturing = false;
    const chunks = this.chunks;
    const sampleRate = this.audioContext?.sampleRate ?? 48_000;
    this.chunks = [];
    this.teardown();
    if (!wasCapturing) return;

    const wav = encodeVoiceWav(chunks, sampleRate);
    this.lastUri = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  }

  release(): void {
    this.generation += 1;
    this.capturing = false;
    this.chunks = [];
    this.teardown();
  }

  private cancelledError(): BrowserVoiceRecorderError {
    return new BrowserVoiceRecorderError("recording-failed", "Voice recording was cancelled.");
  }

  private async attachWorklet(generation: number): Promise<boolean> {
    const context = this.audioContext;
    const source = this.source;
    const gain = this.silentGain;
    if (!context?.audioWorklet || typeof AudioWorkletNode === "undefined" || !source || !gain) {
      return false;
    }
    const moduleUrl = URL.createObjectURL(
      new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
      if (generation !== this.generation) return false;
      const node = new AudioWorkletNode(context, "t3-pcm-collector", {
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event: MessageEvent<ArrayBuffer | Float32Array>) => {
        if (!this.capturing) return;
        this.chunks.push(new Float32Array(event.data));
      };
      source.connect(node);
      node.connect(gain);
      this.worklet = node;
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }

  private attachScriptProcessor(): boolean {
    const context = this.audioContext;
    const source = this.source;
    const gain = this.silentGain;
    if (!context || !source || !gain) return false;
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!this.capturing) return;
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(gain);
    this.processor = processor;
    return true;
  }

  private async finishAutoStop(): Promise<void> {
    this.autoStopTimer = null;
    try {
      await this.stop();
      this.onAutoStop?.({
        isFinished: true,
        hasError: false,
        error: null,
        url: this.lastUri,
      });
    } catch (error) {
      this.onAutoStop?.({
        isFinished: false,
        hasError: true,
        error: error instanceof Error ? error.message : "Voice recording was interrupted.",
        url: this.lastUri,
      });
    }
  }

  private teardown(): void {
    this.processor?.disconnect();
    this.processor = null;
    this.worklet?.disconnect();
    this.worklet = null;
    this.source?.disconnect();
    this.source = null;
    this.silentGain?.disconnect();
    this.silentGain = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.audioContext;
    this.audioContext = null;
    if (context) void context.close().catch(() => undefined);
  }
}

export function createBrowserVoiceRecorder(): BrowserVoiceRecorder {
  return new BrowserVoiceRecorder();
}

export function releaseVoiceRecorder(recorder: VoiceRecorder): void {
  if (recorder instanceof BrowserVoiceRecorder) recorder.release();
}
