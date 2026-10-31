# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. iOS supplies
Apple's on-device transcription; web and desktop send audio to the environment.

The web client records 16 kHz mono PCM16 WAV and sends it over the `voice.transcribe`
RPC to the environment's [transcription service](../../apps/server/src/voice/Transcription.ts),
which runs whisper.cpp. Transcribing on the server keeps audio on your own machine
and means a browser needs no local model. A background install runs without your
shell profile, so discovery checks the usual names on `PATH`, then
`~/.t3-voice/bin/whisper-cli`, and models default to `~/.t3-voice/models/ggml-*.bin`;
`T3CODE_WHISPER_BIN` and `T3CODE_WHISPER_MODEL` override either path. Requests are
limited to 20 MB of decoded audio. whisper.cpp needs 16 kHz WAV; other formats need
`ffmpeg` on the server to convert and fail without it.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
