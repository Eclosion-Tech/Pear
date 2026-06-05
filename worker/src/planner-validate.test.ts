import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskSpecs } from "./llm.js";

test("accepts a well-formed plan unchanged", () => {
  const out = validateTaskSpecs([
    { description: "Make a page", task_type: "llm", depends_on: [], required_capabilities: ["llm"] },
    { description: "Fill it", task_type: "llm", depends_on: [0], required_capabilities: ["llm"] },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].depends_on, [0]);
});

test("non-array input yields an empty plan", () => {
  assert.deepEqual(validateTaskSpecs(null), []);
  assert.deepEqual(validateTaskSpecs("nope"), []);
  assert.deepEqual(validateTaskSpecs({ tasks: [] }), []);
});

test("drops specs with no usable description", () => {
  const out = validateTaskSpecs([
    { description: "", task_type: "llm", depends_on: [], required_capabilities: [] },
    { task_type: "llm" },
    { description: "valid", task_type: "llm", depends_on: [], required_capabilities: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].description, "valid");
});

test("defaults missing capability from task_type", () => {
  const out = validateTaskSpecs([
    { description: "plan more", task_type: "orchestrate", depends_on: [] },
    { description: "do it", task_type: "llm", depends_on: [] },
  ]);
  assert.deepEqual(out[0].required_capabilities, ["orchestrate"]);
  assert.deepEqual(out[1].required_capabilities, ["llm"]);
});

test("coerces unknown task_type to llm", () => {
  const out = validateTaskSpecs([
    { description: "x", task_type: "magic", depends_on: [], required_capabilities: [] },
  ]);
  assert.equal(out[0].task_type, "llm");
});

test("sanitizes depends_on: drops out-of-range, self, and non-integers", () => {
  const out = validateTaskSpecs([
    { description: "a", task_type: "llm", depends_on: [], required_capabilities: [] },
    {
      description: "b",
      task_type: "llm",
      depends_on: [0, 1, 5, -1, 1.5, "x"],
      required_capabilities: [],
    },
  ]);
  // index 1 ref to self (1), out-of-range (5), negative, float, string all dropped → only [0].
  assert.deepEqual(out[1].depends_on, [0]);
});
