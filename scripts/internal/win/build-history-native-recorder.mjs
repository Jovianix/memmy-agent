#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The Windows History recorder requires a Windows x64 build host");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error("Usage: build-history-native-recorder.mjs <destination.exe>");
const source = path.join(root, "App/memmy-agent/src/tools/computer-history/win/native");
const build = process.env.MEMMY_HISTORY_NATIVE_BUILD_DIR || path.join(root, ".cache/history-native-recorder");
execFileSync("cmake", ["-S", source, "-B", build, "-A", "x64", "-DMEMMY_HISTORY_BUILD_TESTS=OFF"], { stdio: "inherit", windowsHide: true });
execFileSync("cmake", ["--build", build, "--config", "Release", "--target", "memmy-history-recorder"], { stdio: "inherit", windowsHide: true });
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(path.join(build, "Release/memmy-history-recorder.exe"), destination);
copyFileSync(path.join(source, "THIRD_PARTY_NOTICES.md"), destination + ".NOTICES.md");
const bytes = readFileSync(destination), sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(destination + ".build.json", JSON.stringify({ sha256, platform: "win32", arch: "x64", source: "windows-history-recorder" }, null, 2) + "\n");
console.log(`Built Windows History recorder SHA-256 ${sha256}`);
