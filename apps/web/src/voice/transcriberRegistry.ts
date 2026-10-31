import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

let transcriber: VoiceTranscriber | null = null;

/**
 * Where a later slice installs the RPC-backed transcriber. Until then the registry
 * stays empty so the composer can explain that this server cannot transcribe.
 */
export function setVoiceTranscriber(next: VoiceTranscriber | null): void {
  transcriber = next;
}

export function getVoiceTranscriber(): VoiceTranscriber | null {
  return transcriber;
}
