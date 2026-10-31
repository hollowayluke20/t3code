import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { voiceCommand } from "./voice.ts";

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.String,
      durationMs: Schema.Number,
      model: Schema.String,
    }),
  ),
);

const FAKE_WAV = (() => {
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
})();

const FAKE_WHISPER_SCRIPT = `#!/bin/sh
echo "$@" > "$(dirname "$0")/args"
printf ' hello from the fake whisper\\n'
`;

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cli-" });
  const binDirectory = path.join(home, ".t3-voice", "bin");
  const modelsDirectory = path.join(home, ".t3-voice", "models");
  yield* fileSystem.makeDirectory(binDirectory, { recursive: true });
  yield* fileSystem.makeDirectory(modelsDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(binDirectory, "whisper-cli"), FAKE_WHISPER_SCRIPT);
  yield* fileSystem.chmod(path.join(binDirectory, "whisper-cli"), 0o755);
  yield* fileSystem.writeFileString(path.join(modelsDirectory, "ggml-small.en.bin"), "fake model");
  const wavPath = path.join(home, "hello.wav");
  yield* fileSystem.writeFile(wavPath, FAKE_WAV);
  return { home, wavPath };
});

const runVoice = (args: ReadonlyArray<string>, home: string) =>
  Command.runWith(voiceCommand, { version: "0.0.0" })(args).pipe(
    Effect.provideService(HostProcess.Environment, { PATH: "" }),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

const testLayer = Layer.mergeAll(NodeServices.layer, Layer.fresh(TestConsole.layer));

it.live("prints the transcribed text", () =>
  Effect.gen(function* () {
    const { home, wavPath } = yield* makeFixture;

    const exit = yield* runVoice(["transcribe", wavPath], home).pipe(Effect.exit);

    expect(exit._tag).toBe("Success");
    expect((yield* TestConsole.logLines).map(String)).toEqual(["hello from the fake whisper"]);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.live("prints JSON with text, duration, and model when --json is set", () =>
  Effect.gen(function* () {
    const { home, wavPath } = yield* makeFixture;

    const exit = yield* runVoice(["transcribe", wavPath, "--json"], home).pipe(Effect.exit);

    expect(exit._tag).toBe("Success");
    const lines = (yield* TestConsole.logLines).map(String);
    const result = decodeResult(lines[0]!);
    expect(result).toMatchObject({
      text: "hello from the fake whisper",
      model: "ggml-small.en.bin",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.live("fails with the service error when no model is available", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, wavPath } = yield* makeFixture;
    yield* fileSystem.remove(path.join(home, ".t3-voice", "models"), { recursive: true });

    const exit = yield* runVoice(["transcribe", wavPath], home).pipe(Effect.exit);

    expect(exit._tag).toBe("Failure");
    const errors = (yield* TestConsole.errorLines).map(String).join("\n");
    expect(errors).toContain("Voice transcription is unavailable");
    expect(errors).toContain(path.join(home, ".t3-voice", "models"));
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
