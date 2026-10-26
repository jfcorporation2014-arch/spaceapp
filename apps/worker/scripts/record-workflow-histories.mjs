import { mkdtemp, mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const version = process.argv[2];
if (!version || !/^[a-z0-9][a-z0-9-]{0,70}$/.test(version)) throw new Error("Usage: npm run temporal:record-histories -- <reviewed-patch-version>");
const root = fileURLToPath(new URL("../tests/fixtures/workflow-histories/", import.meta.url));
const destination = path.join(root, version);
try { await readdir(destination); throw new Error("History versions are immutable; choose a new reviewed patch version"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const staging = await mkdtemp(path.join(tmpdir(), "space-temporal-history-"));
try {
  const require = createRequire(import.meta.url);
  const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, "run", "tests/workflow-sandbox.test.ts", "--reporter=verbose"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit", timeout: 180_000,
    env: { ...process.env, SPACE_TEMPORAL_RECORD_DIR: staging }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Recording tests failed (${result.status}); no baseline was published`);
  const files = (await readdir(staging)).filter((name) => name.endsWith(".json"));
  if (files.length < 9) throw new Error("Incomplete recording: need every workflow and the legacy supervisor");
  await mkdir(root, { recursive: true });
  await mkdir(destination);
  for (const name of files) await copyFile(path.join(staging, name), path.join(destination, name), 1);
  console.log(`Recorded ${files.length} replay-verified synthetic histories in ${destination}`);
} finally {
  const owned = path.resolve(staging);
  if (!owned.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(owned).startsWith("space-temporal-history-"))
    throw new Error("Refusing to remove an unowned recording directory");
  await rm(owned, { recursive: true, force: true });
}
