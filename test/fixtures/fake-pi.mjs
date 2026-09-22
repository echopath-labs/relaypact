#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const scenario = process.env.FAKE_PI_SCENARIO ?? "success";
const write = (name, content) => writeFileSync(path.join(process.cwd(), name), content, "utf8");
const result = (status, summary, residualRisks = []) => {
  process.stdout.write(`${JSON.stringify({ status, summary, residualRisks })}\n`);
};

if (process.argv.includes("--version")) {
  process.stdout.write("0.84.0\n");
  process.exit(0);
}

if (process.argv.includes("--help")) {
  process.stdout.write([
    "Usage: pi [options] [prompt]",
    "--print --mode <mode> (text, json, rpc) --no-session --no-extensions --no-skills",
    "--no-prompt-templates --no-themes --no-context-files --no-approve",
    "--tools <tools> --provider <provider> --model <model>"
  ].join("\n"));
  process.exit(0);
}

switch (scenario) {
  case "final-output":
    write("allowed.txt", "delegated edit\n");
    process.stdout.write(process.env.FAKE_PI_FINAL_OUTPUT);
    break;
  case "final-output-prompt": {
    const prompt = process.argv.at(-1);
    const mode = process.argv[process.argv.indexOf("--mode") + 1];
    const explicit = mode === "text" && prompt.includes("must be exactly one JSON object") &&
      prompt.includes("Do not add prose, Markdown fences, or additional JSON objects.");
    if (explicit) write("allowed.txt", "delegated edit\n");
    result(explicit ? "completed" : "failed", "Final-output instructions checked.");
    break;
  }
  case "environment": {
    write("allowed.txt", "delegated edit\n");
    const isolated = process.env.HOST_SECRET === undefined &&
      process.env.HOME?.includes("relaypact-pi-") &&
      process.env.TMPDIR?.includes("relaypact-pi-") &&
      process.env.PI_CODING_AGENT_SESSION_DIR === process.env.TMPDIR &&
      typeof process.env.PI_CODING_AGENT_DIR === "string";
    result(isolated ? "completed" : "failed", isolated ? "Environment isolated." : "Environment exposed.");
    break;
  }
  case "large-progress": {
    const mode = process.argv[process.argv.indexOf("--mode") + 1];
    // Model Pi's print behavior: JSON mode emits progress; text mode emits
    // only the final assistant response, even when internal work is verbose.
    if (mode === "json") process.stdout.write(`${JSON.stringify({ type: "message_update", text: "x".repeat(150_000) })}\n`);
    write("allowed.txt", "delegated edit\n");
    result("completed", "Bounded edit completed after verbose progress.");
    break;
  }
  case "oversized-final":
    result("completed", "x".repeat(150_000));
    break;
  case "oversized-stderr":
    process.stderr.write("x".repeat(150_000));
    result("completed", "Untrusted completion after oversized diagnostics.");
    break;
  case "success":
    write("allowed.txt", "delegated edit\n");
    result("completed", "Bounded edit completed.");
    break;
  case "breach":
    write("allowed.txt", "delegated edit\n");
    write("private.txt", "out of scope\n");
    result("completed", "Executor reported completion.");
    break;
  case "baseline-breach":
    write("baseline.txt", "executor changed acknowledged baseline\n");
    result("completed", "Executor reported completion.");
    break;
  case "ignored-breach":
    write("allowed.txt", "delegated edit\n");
    write("ignored.txt", "ignored out of scope\n");
    result("completed", "Executor reported completion.");
    break;
  case "git-hook-breach":
    write("allowed.txt", "delegated edit\n");
    writeFileSync(path.join(process.cwd(), ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
    result("completed", "Executor reported completion.");
    break;
  case "git-object-breach":
    write("allowed.txt", "delegated edit\n");
    rmSync(path.join(process.cwd(), ".git", "objects", process.env.FAKE_PI_OBJECT_PATH), { force: true });
    result("completed", "Executor reported completion.");
    break;
  case "config-secret": {
    const auth = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
    const secret = auth.test.key;
    write("allowed.txt", `${secret}\n`);
    result("completed", `Executor reflected ${secret}.`, [`Retained ${secret}.`]);
    break;
  }
  case "credential-path": {
    write(`${process.env.FAKE_PI_PATH_SECRET}.txt`, "path-only credential fixture\n");
    result("completed", "Executor created one allowed path.");
    break;
  }
  case "env-secret": {
    const secret = process.env.FAKE_PI_SECRET;
    write("allowed.txt", `${secret}\n`);
    result("completed", `Executor reflected ${secret}.`);
    break;
  }
  case "encoded-secret": {
    const encoded = Buffer.from(process.env.FAKE_PI_SECRET, "utf8").toString("base64");
    write("allowed.txt", `${encoded}\n`);
    result("completed", "Executor wrote encoded fixture data.");
    break;
  }
  case "config-url-secret": {
    const models = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
    const provider = Object.values(models.providers)[0];
    const secret = decodeURIComponent(new URL(provider.baseUrl).pathname.split("/").filter(Boolean).at(-1));
    write("allowed.txt", `${secret}\n`);
    result("completed", `Executor reflected ${secret}.`);
    break;
  }
  case "config-url-raw-host": {
    const models = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
    const provider = Object.values(models.providers)[0];
    const authority = provider.baseUrl.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u)[1];
    write("allowed.txt", `${authority}\n`);
    result("completed", `Executor reflected ${authority}.`);
    break;
  }
  case "route-bound": {
    const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
    const bound = process.argv.includes("--no-approve") &&
      !process.argv.includes("--approve") &&
      argument("--provider") === process.env.FAKE_PI_EXPECTED_PROVIDER &&
      argument("--model") === process.env.FAKE_PI_EXPECTED_MODEL;
    if (bound) write("allowed.txt", "delegated edit\n");
    result(bound ? "completed" : "failed", bound ? "Resolved route was host-bound." : "Resolved route was not host-bound.");
    break;
  }
  case "zero-write-tools": {
    const tools = process.argv[process.argv.indexOf("--tools") + 1];
    const prompt = process.argv.at(-1);
    const bounded = tools === "read,grep,find,ls" &&
      !tools.includes("bash") && !tools.includes("edit") && !tools.includes("write") &&
      prompt.includes("zero write authority") && prompt.includes("write-capable tools are unavailable");
    result(bounded ? "completed" : "failed", bounded ? "Zero write authority preserved." : "Write-capable Pi tools were exposed.");
    break;
  }
  case "blocked":
    result("blocked", "A host decision is required.", ["Authority is unresolved."]);
    break;
  case "failed":
    process.stderr.write(`${["OPENAI", "API", "KEY"].join("_")}=${["top", "secret"].join("-")} executor failure\n`);
    process.exitCode = 7;
    break;
  case "malformed":
    process.stdout.write("not structured output\n");
    break;
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "nochange":
    result("completed", "No file change was required.");
    break;
  case "branch-change":
    spawnSync("git", ["switch", "-c", "executor-created-branch"], { cwd: process.cwd() });
    result("completed", "Executor changed the branch.");
    break;
  case "staged-rename":
    spawnSync("git", ["mv", "outside.txt", "allowed.txt"], { cwd: process.cwd() });
    result("completed", "Executor staged a rename.");
    break;
  default:
    result("failed", `Unknown fake scenario: ${scenario}.`);
}
