import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { runMigrations } from "../migration-runner.js";
import { createPluginRepository } from "../repositories/plugin-repo.js";

const infrastructure = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationRoot = join(infrastructure, "app-state-store/migrations");
const otherMigrations = [join(infrastructure, "agent-source-store/migrations"), join(infrastructure, "idempotency-store/migrations")];
const manifest = { apiVersion: "memmy/v1", id: "fixture.plugin", name: "Existing plugin", version: "1.0.0",
  runtime: { adapter: "http", config: { baseUrl: "https://fixture.example" } }, permissions: [],
  capabilities: [{ id: "run", name: "Run", description: "Existing capability", inputSchema: {}, outputSchema: {}, execution: "request" }] };

describe("baseline plugin database upgrade", () => {
  it("adds trust columns to the existing baseline tables without changing grants, config or call logs", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-upgrade-")), baseline = join(root, "baseline"); mkdirSync(baseline);
    const db = new DatabaseSync(":memory:");
    try {
      for (const file of readdirSync(migrationRoot).filter(file => file.endsWith(".sql") && file !== "0032-plugin-native-trust.sql")) {
        writeFileSync(join(baseline, file), readFileSync(join(migrationRoot, file)));
      }
      runMigrations(db, [baseline, ...otherMigrations]);
      db.prepare("INSERT INTO installed_plugins (id, version, manifest_json, state, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(manifest.id, manifest.version, JSON.stringify(manifest), "disabled", '{"retained":true}', "2026-10-19T00:00:00Z", "2026-10-19T00:00:00Z");
      db.prepare("INSERT INTO plugin_call_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("old-call", manifest.id, manifest.version, "run", "http", 1, "success", null, "2026-10-19T00:00:00Z");
      const result = runMigrations(db, [migrationRoot, ...otherMigrations]);
      expect(result.applied).toEqual(["0032-plugin-native-trust.sql"]);
      expect(createPluginRepository(db).get(manifest.id)).toMatchObject({ state: "disabled", config: { retained: true }, approvedPermissions: [], nativeExecutionAllowed: false, registryOrigin: null });
      expect(db.prepare("SELECT call_id FROM plugin_call_logs").all()).toEqual([{ call_id: "old-call" }]);
      expect(runMigrations(db, [migrationRoot, ...otherMigrations]).applied).toEqual([]);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("creates a fresh database using the baseline history and one incremental extension", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runMigrations(db, [migrationRoot, ...otherMigrations]);
      const names = db.prepare("SELECT name FROM _migrations WHERE name LIKE '%plugin%'").all().map(row => row.name);
      expect(names).toEqual(expect.arrayContaining(["0026-plugin-host.sql", "0027-plugin-call-log.sql", "0032-plugin-native-trust.sql"]));
      expect(names).not.toContain("0030-plugin-host.sql"); expect(names).not.toContain("0031-plugin-call-log.sql");
    } finally { db.close(); }
  });
});

it("recognizes the unpublished prototype numbering without losing retained plugin records", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-prototype-upgrade-")), prototype = join(root, "prototype"); mkdirSync(prototype);
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(migrationRoot).filter(file => file.endsWith(".sql") && !["0026-plugin-host.sql", "0027-plugin-call-log.sql", "0032-plugin-native-trust.sql"].includes(file))) writeFileSync(join(prototype, file), readFileSync(join(migrationRoot, file)));
    const create = readFileSync(join(migrationRoot, "0026-plugin-host.sql"), "utf8") + "\n" + readFileSync(join(migrationRoot, "0032-plugin-native-trust.sql"), "utf8");
    writeFileSync(join(prototype, "0030-plugin-host.sql"), create);
    writeFileSync(join(prototype, "0031-plugin-call-log.sql"), readFileSync(join(migrationRoot, "0027-plugin-call-log.sql")));
    runMigrations(db, [prototype, ...otherMigrations]);
    db.prepare("INSERT INTO installed_plugins (id, version, manifest_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(manifest.id, manifest.version, JSON.stringify(manifest), "disabled", "2026-10-19T00:00:00Z", "2026-10-19T00:00:00Z");
    expect(() => runMigrations(db, [migrationRoot, ...otherMigrations])).not.toThrow();
    expect(createPluginRepository(db).get(manifest.id)).toMatchObject({ state: "disabled", nativeExecutionAllowed: false });
    expect(db.prepare("SELECT name FROM _migrations WHERE name = '0030-plugin-host.sql'").get()).toBeTruthy();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
