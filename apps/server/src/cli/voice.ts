import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ProcessRunner from "../processRunner.ts";
import * as Transcription from "../voice/Transcription.ts";

const layerTranscriptionCli = Transcription.layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const voiceTranscribeCommand = Command.make("transcribe", {
  file: Argument.String("file").pipe(Argument.withDescription("Audio file to transcribe.")),
  language: Flag.String("language").pipe(
    Flag.withDescription("Spoken language, for example en."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print JSON instead of text."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Transcribe an audio file with the local whisper.cpp install."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filePath = path.resolve(flags.file);
      const bytes = yield* fileSystem.readFile(filePath).pipe(
        Effect.mapError(
          (cause) =>
            new CliError.UserError({
              cause,
              userMessage: `Could not read the audio file ${filePath}.`,
            }),
        ),
      );
      const transcription = yield* Transcription.Transcription;
      const result = yield* transcription
        .transcribe({
          audioBase64: Base64.encode(bytes),
          mimeType: "audio/wav",
          ...(Option.isSome(flags.language) ? { language: flags.language.value } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
          ),
        );
      yield* flags.json
        ? Console.log(
            encodeJson({
              text: result.text,
              durationMs: result.durationMs,
              model: result.model,
            }),
          )
        : Console.log(result.text);
    }).pipe(Effect.provide(layerTranscriptionCli)),
  ),
);

export const voiceCommand = Command.make("voice").pipe(
  Command.withDescription("Transcribe voice audio with the local whisper.cpp install."),
  Command.withSubcommands([voiceTranscribeCommand]),
);
