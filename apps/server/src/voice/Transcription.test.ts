import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Base64 from "effect/encoding/Base64";

import * as ProcessRunner from "../processRunner.ts";
import * as Transcription from "./Transcription.ts";

const FAKE_WAV = (() => {
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
})();

const layerTranscriptionLive = Transcription.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

const FAKE_WHISPER_SCRIPT = `#!/bin/sh
wav=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-f" ]; then
    wav="$arg"
  fi
  previous="$arg"
done
if [ -n "$wav" ]; then
  printf '%s' "$wav" > "$(dirname "$0")/last-wav"
  printf '%s' "$(dirname "$wav")" > "$(dirname "$0")/last-wav-dir"
fi
if [ -f "$(dirname "$0")/fail" ]; then
  echo "fake whisper failure" >&2
  exit 3
fi
echo " fake text"
`;

const writeFakeWhisper = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(directory, "whisper-cli"), FAKE_WHISPER_SCRIPT);
    yield* fileSystem.chmod(path.join(directory, "whisper-cli"), 0o755);
    yield* fileSystem.writeFileString(path.join(directory, "ggml-model.bin"), "fake model");
  });

const writeDefaultVoiceFolder = (
  home: string,
  modelNames: ReadonlyArray<string> = ["ggml-small.en.bin"],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDirectory = path.join(home, ".t3-voice", "bin");
    const modelsDirectory = path.join(home, ".t3-voice", "models");
    yield* fileSystem.makeDirectory(binDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(modelsDirectory, { recursive: true });
    yield* fileSystem.writeFileString(path.join(binDirectory, "whisper-cli"), FAKE_WHISPER_SCRIPT);
    yield* fileSystem.chmod(path.join(binDirectory, "whisper-cli"), 0o755);
    for (const modelName of modelNames) {
      yield* fileSystem.writeFileString(path.join(modelsDirectory, modelName), "fake model");
    }
  });

const fakeEnvironment = (directory: string): NodeJS.ProcessEnv => ({
  PATH: "",
  T3CODE_WHISPER_BIN: `${directory}/whisper-cli`,
  T3CODE_WHISPER_MODEL: `${directory}/ggml-model.bin`,
});

const transcribe = (input: Parameters<Transcription.Transcription["Service"]["transcribe"]>[0]) =>
  Effect.flatMap(Transcription.Transcription, (service) => service.transcribe(input));

const withFakeWhisper = <A, E>(
  body: (
    directory: string,
  ) => Effect.Effect<A, E, Transcription.Transcription | FileSystem.FileSystem | Path.Path>,
  environment: (directory: string) => NodeJS.ProcessEnv = fakeEnvironment,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-voice-test-",
    });
    yield* writeFakeWhisper(directory);
    return yield* body(directory).pipe(
      Effect.provideService(HostProcess.Environment, environment(directory)),
      Effect.provideService(HostProcess.HomeDirectory, directory),
    );
  }).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped);

const withEnvironment = <A, E, R>(effect: Effect.Effect<A, E, R>, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-home-" });
    return yield* effect.pipe(
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  }).pipe(Effect.scoped);

describe("Transcription", () => {
  it.live("runs the configured whisper binary and removes its temporary files", () =>
    withFakeWhisper((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const result = yield* transcribe({
          audioBase64: Base64.encode(FAKE_WAV),
          mimeType: "audio/wav",
          language: "en",
        });

        expect(result.text).toBe("fake text");
        expect(result.model).toBe("ggml-model.bin");
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        const wavPath = yield* fileSystem.readFileString(path.join(directory, "last-wav"));
        const wavDirectory = yield* fileSystem.readFileString(path.join(directory, "last-wav-dir"));
        expect(yield* fileSystem.exists(wavPath)).toBe(false);
        expect(yield* fileSystem.exists(wavDirectory)).toBe(false);
      }),
    ),
  );

  it.live("rejects an empty audio payload as invalid audio", () =>
    withEnvironment(
      Effect.gen(function* () {
        const error = yield* transcribe({ audioBase64: "", mimeType: "audio/wav" }).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe("invalid-audio");
      }),
      {},
    ).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("rejects a payload that is not base64 as invalid audio", () =>
    withEnvironment(
      Effect.gen(function* () {
        const error = yield* transcribe({ audioBase64: "%%%", mimeType: "audio/wav" }).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe("invalid-audio");
      }),
      {},
    ).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("rejects non-WAV audio when ffmpeg is unavailable", () =>
    withEnvironment(
      Effect.gen(function* () {
        const error = yield* transcribe({
          audioBase64: Base64.encode(new Uint8Array([1, 2, 3, 4])),
          mimeType: "audio/webm",
        }).pipe(Effect.flip);
        expect(error.reason).toBe("invalid-audio");
        expect(error.message).toContain("ffmpeg");
      }),
      { PATH: "" },
    ).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("rejects audio larger than the 20 MB limit", () =>
    withEnvironment(
      Effect.gen(function* () {
        const oversized = new Uint8Array(Transcription.VOICE_MAX_AUDIO_BYTES + 1);
        const error = yield* transcribe({
          audioBase64: Base64.encode(oversized),
          mimeType: "audio/wav",
        }).pipe(Effect.flip);
        expect(error.reason).toBe("too-large");
      }),
      {},
    ).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("reports unavailable when no whisper model is configured", () =>
    withEnvironment(
      Effect.gen(function* () {
        const error = yield* transcribe({
          audioBase64: Base64.encode(FAKE_WAV),
          mimeType: "audio/wav",
        }).pipe(Effect.flip);
        expect(error.reason).toBe("unavailable");
        expect(error.message).toContain("T3CODE_WHISPER_MODEL");
      }),
      { PATH: "" },
    ).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("reports unavailable when no whisper binary is configured or on PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-voice-test-",
      });
      const model = path.join(directory, "ggml-model.bin");
      yield* fileSystem.writeFileString(model, "fake model");

      const error = yield* transcribe({
        audioBase64: Base64.encode(FAKE_WAV),
        mimeType: "audio/wav",
      }).pipe(
        Effect.provideService(HostProcess.Environment, {
          PATH: "",
          T3CODE_WHISPER_MODEL: model,
        }),
        Effect.provideService(HostProcess.HomeDirectory, directory),
        Effect.flip,
      );
      expect(error.reason).toBe("unavailable");
      expect(error.message).toContain("T3CODE_WHISPER_BIN");
    }).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("finds whisper and the model in the default voice folder under home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-home-" });
      yield* writeDefaultVoiceFolder(home);

      const result = yield* transcribe({
        audioBase64: Base64.encode(FAKE_WAV),
        mimeType: "audio/wav",
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );

      expect(result.text).toBe("fake text");
      expect(result.model).toBe("ggml-small.en.bin");
    }).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("prefers a large-v3-turbo default model over other sizes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-home-" });
      yield* writeDefaultVoiceFolder(home, [
        "ggml-medium.en.bin",
        "ggml-small.en.bin",
        "ggml-large-v3-turbo-q5_0.bin",
      ]);

      const result = yield* transcribe({
        audioBase64: Base64.encode(FAKE_WAV),
        mimeType: "audio/wav",
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );

      expect(result.model).toBe("ggml-large-v3-turbo-q5_0.bin");
    }).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("prefers a small default model when no large-v3-turbo model exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-home-" });
      yield* writeDefaultVoiceFolder(home, ["ggml-medium.en.bin", "ggml-small.en.bin"]);

      const result = yield* transcribe({
        audioBase64: Base64.encode(FAKE_WAV),
        mimeType: "audio/wav",
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );

      expect(result.model).toBe("ggml-small.en.bin");
    }).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("names the default model folder when no model is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-home-" });

      const error = yield* transcribe({
        audioBase64: Base64.encode(FAKE_WAV),
        mimeType: "audio/wav",
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.flip,
      );

      expect(error.reason).toBe("unavailable");
      expect(error.message).toContain(path.join(home, ".t3-voice", "models"));
    }).pipe(Effect.provide(layerTranscriptionLive), Effect.scoped),
  );

  it.live("reports failed and still removes temporary files when whisper exits nonzero", () =>
    withFakeWhisper((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(directory, "fail"), "");

        const error = yield* transcribe({
          audioBase64: Base64.encode(FAKE_WAV),
          mimeType: "audio/wav",
        }).pipe(Effect.flip);

        expect(error.reason).toBe("failed");
        const wavPath = yield* fileSystem.readFileString(path.join(directory, "last-wav"));
        expect(yield* fileSystem.exists(wavPath)).toBe(false);
      }),
    ),
  );
});
