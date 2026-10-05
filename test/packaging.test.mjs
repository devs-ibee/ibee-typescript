import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("npm pack builds every export from a checkout without dist", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // A suite copied to a tarball consumer can supply the candidate source root.
  const source = process.env.IBEE_TEST_SOURCE ?? root;
  const temp = mkdtempSync(join(tmpdir(), "ibee-pack-test-"));
  try {
    for (const name of ["src", "package.json", "tsup.config.ts", "tsconfig.json", "README.md", "LICENSE"]) {
      cpSync(join(source, name), join(temp, name), { recursive: true });
    }
    assert.equal(existsSync(join(temp, "dist")), false);
    symlinkSync(realpathSync(join(source, "node_modules")), join(temp, "node_modules"), "junction");
    const output = execFileSync("npm", ["pack", "--json", "--cache", join(temp, "cache")],
      { cwd: temp, encoding: "utf8", timeout: 60000 });
    // npm can relay prepack stdout before its JSON result (tsup prints build progress).
    const metadata = JSON.parse(output.slice(output.lastIndexOf("\n[") + 1))[0];
    const manifest = JSON.parse(readFileSync(join(temp, "package.json"), "utf8"));
    const entries = manifest.exports["."];
    const packed = new Set(metadata.files.map(file => file.path));
    for (const entry of [entries.import.default, entries.require.default, entries.import.types, entries.require.types]) {
      assert.ok(packed.has(entry.replace(/^\.\//, "")), `missing packaged export: ${entry}`);
    }
    // Resolve the packed archive by package name from both supported loaders.
    const consumer = join(temp, "consumer");
    execFileSync("npm", ["install", "--prefix", consumer, "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--cache", join(temp, "cache"), join(temp, metadata.filename)], { encoding: "utf8", timeout: 30000 });
    for (const [args, script] of [
      [["--input-type=module"], 'import { Ibee } from "ibee-sdk"; if (typeof Ibee !== "function") process.exit(1);'],
      [[], 'const { Ibee } = require("ibee-sdk"); if (typeof Ibee !== "function") process.exit(1);'],
    ]) execFileSync(process.execPath, [...args, "-e", script], { cwd: consumer, timeout: 10000 });
    for (const extension of ["mts", "cts"]) {
      writeFileSync(join(consumer, `exports.${extension}`), `
import { Ibee, type ComputePlanList } from "ibee-sdk";
const client = new Ibee({ token: "fixture" });
const plans: Promise<ComputePlanList> = client.computeCatalog.listPlans({ workspaceId: "710995", vmType: "cloud" });
void plans;
`);
    }
    execFileSync(process.execPath, [join(source, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "exports.mts", "exports.cts"],
      { cwd: consumer, encoding: "utf8", timeout: 30000 });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
