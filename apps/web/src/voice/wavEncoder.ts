export const VOICE_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;
const PCM_BITS_PER_SAMPLE = 16;

function concatenateChunks(chunks: ReadonlyArray<Float32Array>): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleLinear(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  const targetLength = Math.max(
    1,
    Math.round((samples.length * targetSampleRate) / sourceSampleRate),
  );
  const output = new Float32Array(targetLength);
  const step = sourceSampleRate / targetSampleRate;
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * step;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, samples.length - 1);
    const weight = position - lower;
    output[index] = samples[lower]! * (1 - weight) + samples[upper]! * weight;
  }
  return output;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function sampleToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clamped = sample <= -1 ? -1 : sample >= 1 ? 1 : sample;
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

/**
 * Encodes mono float PCM to a 16 kHz mono 16-bit PCM WAV. Linear interpolation keeps
 * resampling pure JavaScript so the encoder runs in node tests as well as the browser.
 */
export function encodeVoiceWav(
  chunks: ReadonlyArray<Float32Array>,
  sourceSampleRate: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new Error("sourceSampleRate must be a positive number");
  }

  const samples = resampleLinear(concatenateChunks(chunks), sourceSampleRate, VOICE_SAMPLE_RATE);
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(WAV_HEADER_BYTES + index * 2, sampleToInt16(samples[index]!), true);
  }
  return new Uint8Array(buffer);
}
