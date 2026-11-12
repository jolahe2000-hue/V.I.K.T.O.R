import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolExecutor } from "../src/tools.js";
import { createStore } from "../src/store.js";

test("workspace tools read, write, and search files while hiding environment files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-tools-"));
  try {
    await writeFile(path.join(root, ".env"), "SECRET=hidden");
    const execute = createToolExecutor(root, createStore(root));
    await execute("write_file", { path: "src/hello.js", content: "export const message = 'hello';" });
    assert.equal(await execute("read_file", { path: "src/hello.js" }), "export const message = 'hello';");
    assert.match(await execute("search_files", { query: "hello" }), /src[\\/]hello\.js:1/u);
    assert.doesNotMatch(await execute("list_files", {}), /\.env/u);
    await assert.rejects(execute("read_file", { path: "..\\outside.txt" }), /outside/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace tools refuse symbolic links that point outside", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-tools-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "viktor-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "not for Viktor");
    await symlink(outside, path.join(root, "linked"), "junction");
    const execute = createToolExecutor(root, createStore(root));
    await assert.rejects(execute("read_file", { path: "linked/secret.txt" }), /symbolic links/u);
    await assert.rejects(execute("write_file", { path: "linked/new.txt", content: "no" }), /symbolic links/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("test execution requires the explicit permission and rejects arbitrary commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-tools-"));
  try {
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "tests", "sample.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('sample', () => assert.equal(2 + 2, 4));");
    const execute = createToolExecutor(root, createStore(root));
    assert.match(await execute("run_tests", { command: "node --test tests/sample.test.js" }), /not approved/u);
    const result = JSON.parse(await execute("run_tests", { command: "node --test tests/sample.test.js" }, { allowTests: true }));
    assert.equal(result.ok, true);
    await assert.rejects(execute("run_tests", { command: "node -e process.exit(1)" }, { allowTests: true }), /Allowed test commands/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("running a workspace source file requires separate approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-tools-"));
  try {
    await writeFile(path.join(root, "hello.js"), "console.log('hello from Viktor');");
    const execute = createToolExecutor(root, createStore(root));
    assert.match(await execute("run_code", { runtime: "node", path: "hello.js" }), /not approved/u);
    const result = JSON.parse(await execute("run_code", { runtime: "node", path: "hello.js" }, { allowCodeExecution: true }));
    assert.equal(result.ok, true);
    assert.match(result.output, /hello from Viktor/u);
    await assert.rejects(execute("run_code", { runtime: "node", path: "..\\outside.js" }, { allowCodeExecution: true }), /outside/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VIKTOR core edits are blocked until isolated, tested updates exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-tools-"));
  try {
    await mkdir(path.join(root, "src"));
    const execute = createToolExecutor(root, createStore(root), { protectViktorCore: true });
    await assert.rejects(execute("write_file", { path: "src/server.js", content: "unreviewed" }), /live core is disabled/u);
    await execute("write_file", { path: "notes.txt", content: "A normal workspace file." });
    assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "A normal workspace file.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
