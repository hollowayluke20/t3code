import {
  VoiceTranscribeError,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Base64 from "effect/encoding/Base64";

import * as ProcessRunner from "../processRunner.ts";

export const VOICE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const WHISPER_TIMEOUT = "5 minutes";

const isWav = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 12 &&
  String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
  String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";

const fail = (reason: "unavailable" | "invalid-audio" | "too-large" | "failed", message: string) =>
  Effect.fail(new VoiceTranscribeError({ reason, message }));

export class Transcription extends Context.Service<
  Transcription,
  {
    readonly transcribe: (
      input: VoiceTranscribeInput,
    ) => Effect.Effect<VoiceTranscribeResult, VoiceTranscribeError>;
  }
>()("t3/voice/Transcription") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const commandAvailable = (command: string, environment: NodeJS.ProcessEnv) =>
    isCommandAvailable(command, { env: environment }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  // The transcribe span already covers configuration lookup.
  const resolveWhisper = Effect.fnUntraced(function* (environment: NodeJS.ProcessEnv) {
    const configuredModel = environment.T3CODE_WHISPER_MODEL?.trim();
    if (configuredModel === undefined || configuredModel.length === 0) {
      return yield* fail(
        "unavailable",
        "Voice transcription is unavailable: set T3CODE_WHISPER_MODEL to a whisper.cpp ggml model file.",
      );
    }
    const modelExists = yield* fileSystem
      .exists(configuredModel)
      .pipe(Effect.orElseSucceed(() => false));
    if (!modelExists) {
      return yield* fail(
        "unavailable",
        `Voice transcription is unavailable: T3CODE_WHISPER_MODEL points to a missing file (${configuredModel}).`,
      );
    }

    const configuredBinary = environment.T3CODE_WHISPER_BIN?.trim();
    if (configuredBinary !== undefined && configuredBinary.length > 0) {
      if (!(yield* commandAvailable(configuredBinary, environment))) {
        return yield* fail(
          "unavailable",
          `Voice transcription is unavailable: T3CODE_WHISPER_BIN is not an executable file (${configuredBinary}).`,
        );
      }
      return { binary: configuredBinary, model: configuredModel };
    }

    for (const candidate of ["whisper-cli", "whisper-cpp"] as const) {
      if (yield* commandAvailable(candidate, environment)) {
        return { binary: candidate, model: configuredModel };
      }
    }
    return yield* fail(
      "unavailable",
      "Voice transcription is unavailable: install whisper.cpp (whisper-cli), put it on PATH, or set T3CODE_WHISPER_BIN.",
    );
  });

  const transcribe = Effect.fn("Transcription.transcribe")(function* (input: VoiceTranscribeInput) {
    const startedAt = yield* Clock.currentTimeMillis;

    const decoded = Base64.decode(input.audioBase64);
    if (decoded._tag === "Failure") {
      return yield* fail("invalid-audio", "Audio payload is not valid base64.");
    }
    const bytes = decoded.success;
    if (bytes.byteLength === 0) {
      return yield* fail("invalid-audio", "Audio payload is empty.");
    }
    if (bytes.byteLength > VOICE_MAX_AUDIO_BYTES) {
      return yield* fail(
        "too-large",
        `Audio payload is ${bytes.byteLength} bytes; the limit is ${VOICE_MAX_AUDIO_BYTES} bytes.`,
      );
    }
    yield* Effect.annotateCurrentSpan({
      "voice.mime_type": input.mimeType,
      "voice.audio_bytes": bytes.byteLength,
    });

    const environment = yield* HostProcess.Environment;
    const directory = yield* fileSystem.makeTempDirectory({ prefix: "t3-voice-" }).pipe(
      Effect.mapError(
        () =>
          new VoiceTranscribeError({
            reason: "failed",
            message: "Could not prepare temporary audio storage.",
          }),
      ),
    );
    return yield* Effect.gen(function* () {
      const inputPath = path.join(directory, isWav(bytes) ? "input.wav" : "input");
      yield* fileSystem.writeFile(inputPath, bytes).pipe(
        Effect.mapError(
          () =>
            new VoiceTranscribeError({
              reason: "failed",
              message: "Could not write the temporary audio file.",
            }),
        ),
      );

      let wavPath = inputPath;
      if (!isWav(bytes)) {
        if (!(yield* commandAvailable("ffmpeg", environment))) {
          return yield* fail(
            "invalid-audio",
            "Audio is not a WAV file and ffmpeg is not installed to convert it. Send 16 kHz mono PCM16 WAV.",
          );
        }
        wavPath = path.join(directory, "converted.wav");
        const converted = yield* processRunner
          .run({
            command: "ffmpeg",
            args: ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
            timeout: WHISPER_TIMEOUT,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Voice audio conversion failed", { cause }),
            ),
            Effect.mapError(
              () =>
                new VoiceTranscribeError({
                  reason: "invalid-audio",
                  message: "Audio could not be converted to 16 kHz mono PCM16 WAV.",
                }),
            ),
          );
        if (converted.code !== 0) {
          return yield* fail(
            "invalid-audio",
            `Audio could not be converted to WAV (ffmpeg exited with code ${converted.code}).`,
          );
        }
      }

      const whisper = yield* resolveWhisper(environment);
      const language = input.language?.trim() || "en";
      const result = yield* processRunner
        .run({
          command: whisper.binary,
          args: ["-m", whisper.model, "-f", wavPath, "-nt", "-np", "-l", language],
          timeout: WHISPER_TIMEOUT,
        })
        .pipe(
          Effect.tapError((cause) => Effect.logWarning("Whisper transcription failed", { cause })),
          Effect.mapError(
            () =>
              new VoiceTranscribeError({
                reason: "failed",
                message: "Whisper failed to transcribe the audio.",
              }),
          ),
        );
      if (result.code !== 0) {
        return yield* fail(
          "failed",
          `Whisper failed to transcribe the audio (exit code ${result.code}).`,
        );
      }

      const finishedAt = yield* Clock.currentTimeMillis;
      return {
        text: result.stdout.trim(),
        durationMs: Math.max(0, finishedAt - startedAt),
        model: path.basename(whisper.model),
      } satisfies VoiceTranscribeResult;
    }).pipe(
      Effect.ensuring(
        fileSystem
          .remove(directory, { recursive: true, force: true })
          .pipe(Effect.ignore({ log: true })),
      ),
    );
  });

  return Transcription.of({ transcribe });
});

export const layer = Layer.effect(Transcription, make);
