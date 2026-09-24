import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readState, writeState } from "../web/state-file.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "family-state-"));

test("a saved household comes back as it went in", () => {
  const file = join(scratch(), "state.json");
  const snapshot = {
    household: { name: "The Hardys", setUp: true },
    people: [{ id: "tom", name: "Tom" }],
    tasks: [],
  };
  writeState(file, snapshot);
  assert.deepEqual(readState(file), snapshot);
});

test("a first run has no file, and that is not an error", () => {
  assert.equal(readState(join(scratch(), "nothing-here.json")), undefined);
});

test("an unreadable file is kept, not written over", () => {
  // It is somebody's only copy of their household. Starting empty is right;
  // deleting the evidence on the way is not.
  const file = join(scratch(), "state.json");
  writeFileSync(file, "{ this is not json", "utf8");

  assert.equal(readState(file), undefined);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(`${file}.unreadable`, "utf8"), "{ this is not json");
});

test("a snapshot without people is not treated as a household", () => {
  const file = join(scratch(), "state.json");
  writeFileSync(file, JSON.stringify({ household: { name: "Half a file" } }), "utf8");
  assert.equal(readState(file), undefined);
});

test("nothing is left behind mid-write", () => {
  const dir = scratch();
  const file = join(dir, "nested", "state.json");
  writeState(file, { people: [] });
  assert.equal(existsSync(`${file}.writing`), false);
  assert.deepEqual(readState(file), { people: [] });
});
