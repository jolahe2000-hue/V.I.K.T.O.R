import { spawn } from "node:child_process";
import {
  readdir,
  readFile,
  stat,
  lstat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".viktor",
  "Viktor",
  "node_modules",
  "runtime",
  ".venv",
  "venv",
  "__pycache__",
]);
const MAX_FILE_BYTES = 200_000;
const MAX_TOOL_OUTPUT = 10_000;

function isIgnoredName(name) {
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".tmp");
}

function resolveWorkspacePath(root, requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error("A workspace-relative path is required.");
  }
  if (path.isAbsolute(requestedPath) || requestedPath.includes("\0")) {
    throw new Error("Use a relative path inside the workspace.");
  }
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("That path is outside the approved workspace.");
  }
  if (relative.split(path.sep).some((part) => IGNORED_DIRECTORIES.has(part) || isIgnoredName(part))) {
    throw new Error("Access to this path is disabled.");
  }
  return resolved;
}

async function assertNoSymlinkPath(root, file) {
  const relative = path.relative(root, file);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Access through symbolic links is disabled.");
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function walkFiles(root, directory = root, results = [], depth = 0) {
  if (depth > 5 || results.length >= 300) return results;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name) || isIgnoredName(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, results, depth + 1);
    } else if (entry.isFile()) {
      results.push(path.relative(root, fullPath));
      if (results.length >= 300) break;
    }
  }
  return results;
}

function runProcess(command, args, cwd) {
  return new Promise((resolve) => {
    const safeEnvironment = {
      PATH: process.env.PATH || "",
      PATHEXT: process.env.PATHEXT || "",
      SystemRoot: process.env.SystemRoot || "",
      TEMP: process.env.TEMP || "",
      TMP: process.env.TMP || "",
    };
    const child = spawn(command, args, {
      cwd,
      env: safeEnvironment,
      shell: command === "npm.cmd" && process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timedOut = false;
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_TOOL_OUTPUT) output = `${output.slice(0, MAX_TOOL_OUTPUT)}\n[output truncated]`;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not start test runner: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        output: output.trim() || (code === 0 ? "Tests passed with no output." : "Test runner produced no output."),
      });
    });
  });
}

function testCommand(input, root) {
  const command = String(input || "").trim();
  const match = command.match(/^(node --test|npm test|python -m unittest|python -m pytest)(?:\s+(.+))?$/u);
  if (!match) {
    throw new Error("Allowed test commands: node --test, npm test, python -m unittest, or python -m pytest (optionally followed by a relative test file).");
  }
  const [, runner, requestedPath] = match;
  const target = requestedPath ? resolveWorkspacePath(root, requestedPath) : null;
  if (target && path.extname(target) === "") throw new Error("The test file must include its file extension.");
  if (runner === "node --test") return ["node", target ? ["--test", target] : ["--test"]];
  if (runner === "npm test") {
    if (target) throw new Error("npm test does not accept a test file argument.");
    return [process.platform === "win32" ? "npm.cmd" : "npm", ["test"]];
  }
  if (target) {
    if (runner.endsWith("unittest")) {
      const moduleName = path.relative(root, target).replace(/\\/gu, "/").replace(/\.py$/u, "").replace(/\//gu, ".");
      return ["python", ["-m", "unittest", moduleName]];
    }
    return ["python", ["-m", "pytest", path.relative(root, target)]];
  }
  return ["python", runner.endsWith("unittest") ? ["-m", "unittest"] : ["-m", "pytest"]];
}

export function createToolExecutor(root, store, { protectViktorCore = false } = {}) {
  return async function execute(name, args, permissions = {}) {
    switch (name) {
      case "list_files": {
        return (await walkFiles(root)).join("\n") || "No project files found.";
      }
      case "read_file": {
        const file = resolveWorkspacePath(root, args.path);
        await assertNoSymlinkPath(root, file);
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) {
          throw new Error("The path is not a readable file or exceeds the 200 KB limit.");
        }
        return await readFile(file, "utf8");
      }
      case "write_file": {
        const file = resolveWorkspacePath(root, args.path);
        const relative = path.relative(root, file);
        const segments = relative.split(path.sep);
        if (
          protectViktorCore &&
          (["src", "public"].includes(segments[0]) || relative === "package.json")
        ) {
          throw new Error("Editing VIKTOR's live core is disabled. Use a separate development workspace until staged, tested core updates are available.");
        }
        await assertNoSymlinkPath(root, file);
        const contents = String(args.content ?? "");
        if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) throw new Error("File content exceeds the 200 KB limit.");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents, "utf8");
        return `Wrote ${path.relative(root, file)} (${Buffer.byteLength(contents, "utf8")} bytes).`;
      }
      case "search_files": {
        const query = String(args.query || "").trim().toLowerCase();
        if (!query || query.length > 100) throw new Error("Provide a search term of 1 to 100 characters.");
        const files = await walkFiles(root);
        const matches = [];
        for (const relativePath of files) {
          if (matches.length >= 30) break;
          const file = resolveWorkspacePath(root, relativePath);
          const info = await stat(file);
          if (info.size > MAX_FILE_BYTES) continue;
          const contents = await readFile(file, "utf8").catch(() => "");
          if (contents.includes("\0")) continue;
          contents.split(/\r?\n/u).forEach((line, index) => {
            if (matches.length < 30 && line.toLowerCase().includes(query)) {
              matches.push(`${relativePath}:${index + 1}: ${line.slice(0, 300)}`);
            }
          });
        }
        return matches.join("\n") || "No matching text found.";
      }
      case "run_tests": {
        if (!permissions.allowTests) {
          return "Test execution was not approved for this request. Ask the user to enable 'Allow test execution' and retry.";
        }
        const [program, commandArgs] = testCommand(args.command, root);
        return JSON.stringify(await runProcess(program, commandArgs, root));
      }
      case "run_code": {
        if (!permissions.allowCodeExecution) {
          return "Code execution was not approved for this request. Ask the user to enable 'Allow code execution' and retry.";
        }
        const runtime = args.runtime;
        if (runtime !== "node" && runtime !== "python") {
          throw new Error("Choose either the node or python runtime.");
        }
        const file = resolveWorkspacePath(root, args.path);
        await assertNoSymlinkPath(root, file);
        const info = await stat(file);
        const allowedExtensions = runtime === "node" ? [".js", ".mjs", ".cjs"] : [".py"];
        if (!info.isFile() || !allowedExtensions.includes(path.extname(file).toLowerCase())) {
          throw new Error(`The ${runtime} runner accepts only ${allowedExtensions.join(", ")} files.`);
        }
        const extraArgs = args.args ?? [];
        if (
          !Array.isArray(extraArgs) ||
          extraArgs.length > 10 ||
          extraArgs.some((value) => typeof value !== "string" || value.length > 200)
        ) {
          throw new Error("Use at most 10 string arguments, each no longer than 200 characters.");
        }
        const executable = runtime === "node" ? "node" : "python";
        const commandArgs = [file, ...extraArgs];
        return JSON.stringify(await runProcess(executable, commandArgs, root));
      }
      case "create_agent": {
        const name = String(args.name || "").trim();
        const description = String(args.description || "").trim();
        const instructions = String(args.instructions || "").trim();
        if (!name || name.length > 60 || !description || description.length > 240 || !instructions || instructions.length > 8000) {
          throw new Error("Provide a name (1-60 characters), description (1-240 characters), and instructions (1-8000 characters).");
        }
        const agent = await store.createAgent({ name, description, instructions });
        return JSON.stringify({ id: agent.id, name: agent.name, saved: true });
      }
      case "remember": {
        const content = String(args.content || "").trim();
        if (!content || content.length > 2000) throw new Error("Memory must be between 1 and 2000 characters.");
        const memory = await store.remember(content);
        return `Saved local memory ${memory.id}.`;
      }
      case "recall": {
        const memories = await store.getMemories();
        return memories.length ? memories.map((item) => `- ${item.content}`).join("\n") : "No saved memories.";
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List project files in the approved workspace.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 project file (maximum 200 KB).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace a file inside the approved workspace (maximum 200 KB).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search text in project files.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run an approved, allow-listed test runner in the workspace. Requires explicit permission from the user.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description: "Run a Node.js or Python source file from the workspace. Requires explicit permission from the user.",
      parameters: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["node", "python"] },
          path: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["runtime", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_agent",
      description: "Save a usable specialized agent that can be selected in the VIKTOR interface.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string" },
        },
        required: ["name", "description", "instructions"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a useful user preference or project fact in local memory.",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Read saved local memories.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];
