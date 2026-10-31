import * as Schema from "effect/Schema";

export const VoiceTranscribeInput = Schema.Struct({
  /** WAV, 16 kHz mono PCM16 preferred. */
  audioBase64: Schema.String,
  mimeType: Schema.String,
  /** Whisper language code, such as `en`; defaults to `en` on the server. */
  language: Schema.optional(Schema.String),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
  durationMs: Schema.Number,
  model: Schema.String,
});
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export class VoiceTranscribeError extends Schema.TaggedError<VoiceTranscribeError>()(
  "VoiceTranscribeError",
  {
    reason: Schema.Literals(["unavailable", "invalid-audio", "too-large", "failed"]),
    message: Schema.String,
  },
) {}
