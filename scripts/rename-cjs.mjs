// Move the CommonJS build into dist/ as .cjs so both ESM and CJS resolve.
import { readdir, rename, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cjsDir = "dist-cjs";
const distDir = "dist";

if (!existsSync(cjsDir)) {
  console.error("dist-cjs not found — run the CJS tsc build first");
  process.exit(1);
}
if (!existsSync(distDir)) await mkdir(distDir, { recursive: true });

for (const file of await readdir(cjsDir)) {
  if (file.endsWith(".js")) {
    const base = file.slice(0, -3);
    await rename(join(cjsDir, file), join(distDir, `${base}.cjs`));
  }
}
await rm(cjsDir, { recursive: true, force: true });
console.log("CJS build merged into dist/ as .cjs");
