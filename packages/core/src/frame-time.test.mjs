import test from "node:test";
import assert from "node:assert/strict";
import { fpsValue, secondsToFrameRange, mapEventToScenes } from "./frame-time.mjs";

test("converts second events into clamped integer frame ranges", () => {
  assert.deepEqual(secondsToFrameRange({ start: 2, end: 3.5 }, { numerator: 30, denominator: 1 }), { startFrame: 60, endFrame: 105 });
  assert.deepEqual(secondsToFrameRange({ start: 0.5, end: 1.25 }, "30"), { startFrame: 15, endFrame: 38 });
  assert.deepEqual(secondsToFrameRange({ start: 1.001, end: 1.5 }, { numerator: 30000, denominator: 1001 }), { startFrame: 30, endFrame: 45 });
  assert.deepEqual(secondsToFrameRange({ start: -2, end: 1 }, { numerator: 30, denominator: 1 }), { startFrame: 0, endFrame: 30 });
  assert.deepEqual(secondsToFrameRange({ start: 2, end: 1 }, { numerator: 30, denominator: 1 }), { startFrame: 60, endFrame: 60 });
});

test("collapses unknown ends and bare instants to a single frame", () => {
  assert.deepEqual(secondsToFrameRange({ start: 2, end: null }, { numerator: 30, denominator: 1 }), { startFrame: 60, endFrame: 61 });
  assert.deepEqual(secondsToFrameRange(2.6, { numerator: 30, denominator: 1 }), { startFrame: 78, endFrame: 79 });
});

test("returns no range when fps or seconds are unusable", () => {
  assert.equal(secondsToFrameRange({ start: 1, end: 2 }, { numerator: 0, denominator: 1 }), null);
  assert.equal(secondsToFrameRange({ start: Number.NaN, end: 2 }, { numerator: 30, denominator: 1 }), null);
  assert.equal(secondsToFrameRange(null, { numerator: 30, denominator: 1 }), null);
});

test("fpsValue accepts rationals, rational strings and plain numbers", () => {
  assert.ok(Math.abs(fpsValue({ numerator: 30000, denominator: 1001 }) - 29.97002997002997) < 1e-12);
  assert.ok(Math.abs(fpsValue("30000/1001") - 29.97002997002997) < 1e-12);
  assert.equal(fpsValue("30"), 30);
  assert.equal(fpsValue(24), 24);
  assert.equal(fpsValue({ numerator: -1, denominator: 1 }), 0);
  assert.equal(fpsValue({}), 0);
  assert.equal(fpsValue(undefined), 0);
});

test("maps events onto scenes using declared or cumulative starts", () => {
  const scenes = [
    { id: "intro", durationFrames: 30 },
    { id: "mid", startFrame: 30, durationFrames: 30 },
    { id: "outro", durationFrames: 30 }
  ];
  assert.deepEqual(mapEventToScenes(60, 105, scenes), ["outro"]);
  assert.deepEqual(mapEventToScenes(10, 40, scenes), ["intro", "mid"]);
  assert.deepEqual(mapEventToScenes(90, 99, scenes), []);
  assert.deepEqual(mapEventToScenes(60, 60, scenes), ["outro"]);
});

test("ignores unusable scenes and events", () => {
  assert.deepEqual(mapEventToScenes(0, 5, null), []);
  assert.deepEqual(mapEventToScenes(Number.NaN, 5, [{ id: "a", durationFrames: 10 }]), []);
  assert.deepEqual(mapEventToScenes(0, 5, [{ durationFrames: 10 }]), []);
  assert.deepEqual(mapEventToScenes(0, 5, [{ id: "late", startFrame: 100, durationFrames: 10 }]), []);
  assert.deepEqual(mapEventToScenes(65, 66, [{ id: "a", startFrame: 50, durationFrames: 10 }, { id: "b", durationFrames: 10 }]), ["b"]);
});
