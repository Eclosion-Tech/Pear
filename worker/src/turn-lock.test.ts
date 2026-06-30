import { test } from "node:test";
import assert from "node:assert/strict";

import { TurnLock } from "./turn-lock.js";

const A = "selfA:1";
const B = "selfA:2";

test("first begin acquires the turn", () => {
  const lock = new TurnLock();
  assert.equal(lock.begin(A), true);
  assert.equal(lock.isActive(A), true);
});

test("a second begin while active does NOT start a concurrent turn", () => {
  const lock = new TurnLock();
  lock.begin(A);
  assert.equal(lock.begin(A), false);
  assert.equal(lock.isPending(A), true);
});

test("end after a deferred begin signals re-dispatch exactly once", () => {
  const lock = new TurnLock();
  lock.begin(A);
  lock.begin(A);
  assert.equal(lock.end(A), true);
  assert.equal(lock.isActive(A), false);
  assert.equal(lock.isPending(A), false);
});

test("end with no deferred message signals no re-dispatch", () => {
  const lock = new TurnLock();
  lock.begin(A);
  assert.equal(lock.end(A), false);
});

test("after release a new turn can be acquired (serialized, not dropped)", () => {
  const lock = new TurnLock();
  lock.begin(A);
  lock.begin(A);
  assert.equal(lock.end(A), true);
  assert.equal(lock.begin(A), true);
  assert.equal(lock.isActive(A), true);
});

test("multiple mid-turn messages collapse into a single re-dispatch", () => {
  const lock = new TurnLock();
  lock.begin(A);
  assert.equal(lock.begin(A), false);
  assert.equal(lock.begin(A), false);
  assert.equal(lock.begin(A), false);
  assert.equal(lock.end(A), true);
  assert.equal(lock.isPending(A), false);
});

test("different conversations are independent", () => {
  const lock = new TurnLock();
  assert.equal(lock.begin(A), true);
  assert.equal(lock.begin(B), true);
  assert.equal(lock.end(A), false);
  assert.equal(lock.isActive(B), true);
});
