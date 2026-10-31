import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Base64 from "effect/encoding/Base64";

import * as ProcessRunner from "../processRunner.ts";
import * as Transcription from "./Transcription.ts";

const FIXTURE_PATH = `${import.meta.dirname}/__fixtures__/hello-from-the-mac-mini.wav`;

const layerTranscriptionLive = Transcription.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe.runIf(Boolean(process.env.T3CODE_WHISPER_MODEL))(
  "Transcription with a real whisper.cpp install",
  () => {
    it.live("transcribes the recorded fixture", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const audioBase64 = Base64.encode(yield* fileSystem.readFile(FIXTURE_PATH));
        const service = yield* Transcription.Transcription;

        const result = yield* service.transcribe({
          audioBase64,
          mimeType: "audio/wav",
          language: "en",
        });

        yield* Effect.logInfo("voice.transcribe fixture text", { text: result.text });
        expect(result.text).toMatch(/hello/i);
        expect(result.model).not.toBe("");
        expect(result.durationMs).toBeGreaterThan(0);
      }).pipe(Effect.provide(layerTranscriptionLive)),
    );
  },
);
