#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("cursor-agent 2026.08.25-3e8eec8\n");
  process.exit(0);
}

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Usage: cursor-agent [options]",
    "--print",
    "--output-format <format>",
    "--workspace <path>",
    "--sandbox <mode>",
    "--resume <session>",
    "--force",
    "--mode <mode>"
  ].join("\n"));
  process.exit(0);
}

if (process.argv.at(-1) === "status") {
  process.stdout.write("Authenticated\n");
  process.exit(0);
}

const prompt = process.argv.at(-1) ?? "";
const taskId = prompt.match(/"taskId":\s*"([^"]+)"/u)?.[1] ?? "cursor-malformed";
const scenario = taskId.replace(/^cursor-/u, "");
const write = (name, content) => writeFileSync(path.join(process.cwd(), name), content, "utf8");
const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (scenario === "process-failure") {
  process.stderr.write("cursor fixture process failed\n");
  process.exit(7);
}

event({
  type: "system",
  subtype: "init",
  session_id: scenario === "session-drift" && prompt.includes("authorized correction")
    ? "different-cursor-session"
    : "fixture-cursor-session",
  ...(scenario === "model-unavailable" ? {} : { model: scenario === "model-auto" ? "Auto" : "fixture-cursor-model" })
});

if (scenario === "hang") {
  setInterval(() => {}, 1000);
} else if (scenario === "breach") {
  write("allowed.txt", "delegated cursor edit\n");
  write("private.txt", "out of scope\n");
  event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: "completed", summary: "Cursor reported completion." }) });
} else if (scenario === "git-control") {
  write("allowed.txt", "delegated cursor edit\n");
  writeFileSync(path.join(process.cwd(), ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
  event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: "completed", summary: "Cursor reported completion." }) });
} else if (scenario === "environment") {
  const isolated = process.env.HOST_SECRET === undefined && typeof process.env.HOME === "string";
  if (isolated) write("allowed.txt", "delegated cursor edit\n");
  event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: isolated ? "completed" : "failed", summary: isolated ? "Environment minimized." : "Ambient environment exposed." }) });
} else if (scenario === "read-only") {
  const bounded = process.argv.includes("--mode") && process.argv.includes("plan") && !process.argv.includes("--force");
  event({ type: "result", subtype: "success", is_error: false, result: `README inspected without mutation.\n${JSON.stringify({ status: bounded ? "completed" : "failed", summary: bounded ? "Read-only mode preserved." : "Read-only mode was not preserved." })}` });
} else if (scenario === "blocked") {
  event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: "blocked", summary: "Host authority is required." }) });
} else if (scenario === "terminal-failure") {
  event({ type: "result", subtype: "error", is_error: true, result: "failed" });
} else if (scenario === "duplicate-terminal") {
  const value = { type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: "completed", summary: "Duplicate." }) };
  event(value);
  event(value);
} else if (scenario === "malformed") {
  event({ type: "result", subtype: "success", is_error: false, result: "not structured" });
} else if (scenario === "resume") {
  const resumed = process.argv.includes("--resume=fixture-cursor-session");
  if (resumed) write("allowed.txt", "resumed cursor edit\n");
  event({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ status: resumed ? "completed" : "failed", summary: resumed ? "Resumed." : "Resume missing." })
  });
} else if (scenario === "lifecycle" || scenario === "session-drift") {
  const correction = prompt.includes("authorized correction") && process.argv.includes("--resume=fixture-cursor-session");
  write("allowed.txt", correction ? "corrected cursor lifecycle edit\n" : "initial cursor lifecycle edit\n");
  event({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ status: "completed", summary: correction ? "Correction completed." : "Initial lifecycle execution completed." })
  });
} else {
  write("allowed.txt", "delegated cursor edit\n");
  event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: "completed", summary: "Bounded Cursor edit completed." }) });
}
