import {
  VoiceTranscribeError,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from "@t3tools/contracts";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import * as Schema from "effect/Schema";

export type EnvironmentVoiceTranscribe = (
  input: VoiceTranscribeInput,
  options: VoiceTranscriptionOptions,
) => Promise<VoiceTranscribeResult>;

const UNSUPPORTED_SERVER_MESSAGE = "This server does not support voice input. Update the server.";

// 8 KiB batches keep String.fromCharCode arguments far below engine stack limits.
const BASE64_CHUNK_BYTES = 0x8000;

const isVoiceTranscribeError = Schema.is(VoiceTranscribeError);

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

function isUnsupportedServer(error: unknown): boolean {
  return /unknown request tag/i.test(errorText(error));
}

function mapVoiceTranscriptionFailure(error: unknown): VoiceTranscriptionError {
  if (isUnsupportedServer(error)) {
    return new VoiceTranscriptionError("unavailable", UNSUPPORTED_SERVER_MESSAGE, { cause: error });
  }
  if (isVoiceTranscribeError(error)) {
    const code = error.reason === "unavailable" ? "unavailable" : "transcription-failed";
    return new VoiceTranscriptionError(code, error.message, { cause: error });
  }
  if (error instanceof VoiceTranscriptionError) return error;
  return new VoiceTranscriptionError(
    "transcription-failed",
    "Could not transcribe this recording.",
    { cause: error },
  );
}

async function transcribeRecording(
  callTranscribe: EnvironmentVoiceTranscribe,
  uri: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  try {
    const response = await fetch(uri, { signal });
    if (!response.ok) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "Could not read the voice recording.",
      );
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    throwIfVoiceTranscriptionAborted(signal);

    const result = await callTranscribe(
      { audioBase64: encodeBase64(audio), mimeType: "audio/wav", language: "en" },
      { signal },
    );
    throwIfVoiceTranscriptionAborted(signal);
    return result.text;
  } catch (error) {
    if (signal.aborted) {
      throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.", {
        cause: error,
      });
    }
    throw mapVoiceTranscriptionFailure(error);
  }
}

export function createEnvironmentVoiceTranscriber(
  callTranscribe: EnvironmentVoiceTranscribe,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: "en-US",
        transcribe: (uri, options) => transcribeRecording(callTranscribe, uri, options),
      };
    },
  };
}
