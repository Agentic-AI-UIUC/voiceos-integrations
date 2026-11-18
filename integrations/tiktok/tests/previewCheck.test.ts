import { describe, expect, test } from "bun:test";
import { encodeMicroFrame, joinMicroPreview } from "../src/microPreview.ts";
import { previewMisleads } from "../src/tools/writes.ts";

function frame(seed: number): string {
  const w = 18, h = 32, rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    rgb[i] = (x * 13 + seed * 40) & 255; rgb[i + 1] = (y * 7 + seed * 90) & 255; rgb[i + 2] = ((x + y) * 5 + seed * 20) & 255;
  }
  return encodeMicroFrame(rgb, w, h);
}
const A = joinMicroPreview([frame(1), frame(2), frame(3)], { durationSec: 42 });
const B = joinMicroPreview([frame(4), frame(5), frame(6)], { durationSec: 42 });

describe("previewMisleads (the card's preview vs the one minted for the file)", () => {
  test("the exact minted preview is fine", () => expect(previewMisleads(A, A)).toBe(false));
  test("another video's preview is refused", () => expect(previewMisleads(B, A)).toBe(true));
  test("a garbled copy only hides frames, so it isn't refused", () => {
    const parts = A.split("~");
    const f = parts[2]!;
    parts[2] = f.slice(0, 20) + (f[20] === "A" ? "B" : "A") + f.slice(21);
    const garbled = parts.join("~");
    expect(garbled).not.toBe(A);
    // Each frame has a checksum: a one-character change almost always fails it (then the card skips that frame).
    // If it happens to decode, it's not one of A's frames and the check refuses. Either way the user never saw
    // a frame from another video without the write being refused.
    const { decodeMicroFrame } = require("../src/microPreview.ts");
    expect(previewMisleads(garbled, A)).toBe(decodeMicroFrame(parts[2]) !== null);
  });
  test("a frame dropped from the copy is fine", () => {
    const parts = A.split("~");
    expect(previewMisleads([parts[0], parts[1], parts[3]].join("~"), A)).toBe(false);
  });
  test("a different duration is refused (the card's duration pill reads it)", () => {
    expect(previewMisleads(A.replace(/^p1\.42/, "p1.24"), A)).toBe(true);
  });
  test("a preview for a file that had none is refused when it decodes", () => expect(previewMisleads(B, undefined)).toBe(true));
  test("text that isn't a preview at all shows the plain tile, so it isn't refused", () => expect(previewMisleads("hello", A)).toBe(false));
});

describe("version 2 previews and stacks (what find_recent_videos and prepare_photo_post mint now)", () => {
  const { encodeStackFrame, encodeVideoFrame, joinStack, joinVideoPreview, decodeFrame } = require("../src/microPreview.ts");
  const { stackMisleads } = require("../src/tools/writes.ts");
  const still = (seed: number, w: number, h: number) => {
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      rgb[i] = (x * 9 + seed * 40) & 255; rgb[i + 1] = (y * 5 + seed * 90) & 255; rgb[i + 2] = ((x ^ y) * 4 + seed * 20) & 255;
    }
    return rgb;
  };
  const vf = (seed: number) => encodeVideoFrame(still(seed, 45, 80), 45, 80) as string;
  const sf = (seed: number) => encodeStackFrame(still(seed, 48, 64), 48, 64) as string;
  const A2 = joinVideoPreview([vf(1), vf(2), vf(3)], { durationSec: 42 }) as string;
  const B2 = joinVideoPreview([vf(4), vf(5), vf(6)], { durationSec: 42 }) as string;
  const S = joinStack([sf(1), sf(2), sf(3)], { count: 3, cover: 0 }) as string;
  const T = joinStack([sf(4), sf(5), sf(6)], { count: 3, cover: 0 }) as string;

  test("the minted strings fit the schema caps", () => {
    expect(A2.length).toBeLessThanOrEqual(1_100);
    expect(S.length).toBeLessThanOrEqual(1_500);
  });
  test("its own preview passes; another video's frames are refused", () => {
    expect(previewMisleads(A2, A2)).toBe(false);
    expect(previewMisleads(B2, A2)).toBe(true);
    expect(previewMisleads(`p2.42~${vf(1)}~${vf(9)}`, A2)).toBe(true);
    expect(previewMisleads(B2, undefined)).toBe(true);
  });
  test("a dropped frame or a garbled one isn't refused; padding the copy with zero characters isn't either", () => {
    const parts = A2.split("~");
    expect(previewMisleads([parts[0], parts[1], parts[3]].join("~"), A2)).toBe(false);
    const f = parts[2]!;
    const garbled = [parts[0], parts[1], f.slice(0, 30) + (f[30] === "x" ? "y" : "x") + f.slice(31), parts[3]].join("~");
    expect(previewMisleads(garbled, A2)).toBe(decodeFrame(garbled.split("~")[2]) !== null);
    expect(previewMisleads(`${parts[0]}~${parts[1]}AA~${parts[2]}`, A2)).toBe(false);
  });
  test("another duration, or an old-format preview where a v2 one was minted, is refused when it decodes", () => {
    expect(previewMisleads(A2.replace(/^p2\.42/, "p2.24"), A2)).toBe(true);
    expect(previewMisleads(A, A2)).toBe(true);
  });
  test("stacks: own frames in order pass; a stranger, a reorder, another count or cover is refused", () => {
    const own = S.split("~").slice(1);
    expect(stackMisleads(S, S)).toBe(false);
    expect(stackMisleads(`s2.3.0~${own[0]}~${own[2]}`, S)).toBe(false); // a frame dropped
    expect(stackMisleads(`s2.3.0~${own[0]}A~${own[1]}`, S)).toBe(false); // zero padding
    expect(stackMisleads(T, S)).toBe(true);
    expect(stackMisleads(`s2.3.0~${own[1]}~${own[0]}`, S)).toBe(true);
    expect(stackMisleads(`s2.4.0~${own.join("~")}`, S)).toBe(true);
    expect(stackMisleads(`s2.3.2~${own.join("~")}`, S)).toBe(true);
    expect(stackMisleads("s2~AAAAAAAA", S)).toBe(false); // nothing decodes: the card shows its fallback
  });
});
