import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

// A disposable cluster over a private Unix socket. No existing PostgreSQL instance is touched.
const root = await mkdtemp("/private/tmp/pluggy-mcp-pg-").catch(() =>
  mkdtemp("/tmp/pluggy-mcp-pg-"),
);
const data = `${root}/data`;
const socket = `${root}/socket`;
let started = false;
const binary = (name) =>
  process.env.PG_BINDIR ? join(process.env.PG_BINDIR, name) : name;
try {
  await mkdir(socket);
  execFileSync(
    binary("initdb"),
    ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"],
    { stdio: "pipe" },
  );
  execFileSync(
    binary("pg_ctl"),
    [
      "-D",
      data,
      "-l",
      `${root}/postgres.log`,
      "-o",
      `-k ${socket} -h '' -p 55432 -F`,
      "-w",
      "start",
    ],
    { stdio: "pipe" },
  );
  started = true;
  const result = spawnSync("npm", ["run", "test:integration"], {
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}&port=55432`,
    },
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(
    "Isolated PostgreSQL test setup failed. Ensure initdb and pg_ctl are on PATH.",
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started)
    execFileSync(
      binary("pg_ctl"),
      ["-D", data, "-m", "immediate", "-w", "stop"],
      { stdio: "pipe" },
    );
  await rm(root, { recursive: true, force: true });
}
