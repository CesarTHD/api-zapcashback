import { Pool, PoolClient } from "pg";

let pool: Pool | undefined;
export function satDb() {
  if (!process.env.SAT_DATABASE_URL) throw new Error("Banco da aplicação SAT indisponível");
  return pool ??= new Pool({ connectionString: process.env.SAT_DATABASE_URL, statement_timeout: 15000 });
}

export async function transaction<T>(run: (db: PoolClient) => Promise<T>) {
  const db = await satDb().connect();
  try {
    await db.query("BEGIN");
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
