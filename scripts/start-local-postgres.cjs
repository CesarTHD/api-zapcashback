const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("dotenv");
const { Client } = require("pg");

const api = path.resolve(__dirname, "..");
const runtime = path.join(api, "..", ".sat-postgres");
const data = path.join(runtime, "data");
const bin = path.join(runtime, "node_modules", "@embedded-postgres", "windows-x64", "native", "bin");
const port = "55432";
const envPath = path.join(api, ".env");
const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const configured = parse(current).SAT_DATABASE_URL;
const localPrefix = "postgresql://sat_local:";
const localSuffix = `@127.0.0.1:${port}/sat_cashback`;
if (process.argv.includes("--if-configured") &&
  (!configured?.startsWith(localPrefix) || !configured.endsWith(localSuffix))) {
  process.exit(0);
}
if (configured && (!configured.startsWith(localPrefix) || !configured.endsWith(localSuffix))) {
  throw new Error("SAT_DATABASE_URL aponta para outro banco. Preserve essa configuração antes de criar o banco local.");
}
const password = configured ? new URL(configured).password : randomBytes(32).toString("hex");
const run = (name, args, options = {}) => execFileSync(path.join(bin, name + ".exe"), args, {
  windowsHide: true,
  stdio: "inherit",
  ...options,
});

if (!fs.existsSync(path.join(data, "PG_VERSION"))) {
  const credentialFile = path.join(runtime, "initdb-" + randomBytes(12).toString("hex"));
  fs.writeFileSync(credentialFile, password + "\n", { flag: "wx" });
  try {
    run("initdb", ["-D", data, "-U", "sat_local", "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", "--pwfile=" + credentialFile]);
  } finally {
    fs.unlinkSync(credentialFile);
  }
}
if (!configured) {
  fs.appendFileSync(envPath, `\nSAT_DATABASE_URL=${localPrefix}${password}${localSuffix}\n`);
}
try {
  run("pg_ctl", ["-D", data, "status"], { stdio: "ignore" });
} catch (error) {
  if (error.status !== 3) throw error;
  run("pg_ctl", ["-D", data, "-l", path.join(runtime,"postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
}
async function provision() {
  const connection = { host: "127.0.0.1", port: Number(port), user: "sat_local", password, connectionTimeoutMillis: 5000 };
  const admin = new Client({ ...connection, database: "postgres" });
  try {
    await admin.connect();
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname='sat_cashback'");
    if (!existing.rowCount) await admin.query("CREATE DATABASE sat_cashback");
  } finally { await admin.end(); }

  const database = new Client({ ...connection, database: "sat_cashback" });
  try {
    await database.connect();
    await database.query(fs.readFileSync(path.join(api,"migrations","001_sat.sql"),"utf8"));
    console.log("PostgreSQL SAT disponível em 127.0.0.1:55432/sat_cashback.");
  } finally { await database.end(); }
}
provision().catch(error => {
  console.error("Falha no provisionamento PostgreSQL:", error.code || error.name);
  process.exitCode = 1;
});
