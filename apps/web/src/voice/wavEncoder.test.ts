import { describe, expect, it } from "vite-plus/test";

import { encodeVoiceWav, VOICE_SAMPLE_RATE } from "./wavEncoder";

function ascii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}

function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataBytes = view.getUint32(40, true);
  const values: number[] = [];
  for (let offset = 44; offset < 44 + dataBytes; offset += 2) {
    values.push(view.getInt16(offset, true));
  }
  return values;
}

describe("encodeVoiceWav", () => {
  it("writes a 16 kHz mono 16-bit PCM WAV header and sample values", () => {
    const bytes = encodeVoiceWav([new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])], 16_000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(bytes.byteLength).toBe(44 + 6 * 2);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 12);
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(VOICE_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(12);
    expect(samples(bytes)).toEqual([0, 16_384, -16_384, 32_767, -32_768, 8_192]);
  });

  it("resamples 32 kHz chunks to 16 kHz by linear interpolation", () => {
    const bytes = encodeVoiceWav([new Float32Array([0, 0.5]), new Float32Array([-0.5, 1])], 32_000);

    expect(bytes.byteLength).toBe(44 + 2 * 2);
    expect(samples(bytes)).toEqual([0, -16_384]);
  });

  it("interpolates between neighbouring samples when upsampling", () => {
    const bytes = encodeVoiceWav([new Float32Array([0.25, 0.5, 0.75, 1])], 8_000);

    expect(bytes.byteLength).toBe(44 + 8 * 2);
    expect(samples(bytes)).toEqual([8_192, 12_288, 16_384, 20_479, 24_575, 28_671, 32_767, 32_767]);
  });

  it("keeps an empty recording to a bare header", () => {
    const bytes = encodeVoiceWav([], 48_000);

    expect(bytes.byteLength).toBe(44);
    expect(samples(bytes)).toEqual([]);
  });

  it("rejects a non-positive source sample rate", () => {
    expect(() => encodeVoiceWav([], 0)).toThrow("sourceSampleRate");
  });
});
