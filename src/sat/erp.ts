import { attach, ISOLATION_READ_COMMITTED_READ_ONLY, NUMERIC_MODE_STRING, Options, Database, Transaction } from "node-firebird";

export type Branches = number[] | null;
type Parameter = string | number;

export async function readErp<T>(sql: string, params: Parameter[] = [], exact = false): Promise<T[]> {
  const options: Options = {
    host: process.env.SAT_DB_HOST || "localhost",
    port: Number(process.env.SAT_DB_PORT || 3050),
    database: process.env.SAT_DB_DATABASE || "",
    user: process.env.SAT_DB_USER || "",
    password: process.env.SAT_DB_PASSWORD || "",
    numericMode: exact ? NUMERIC_MODE_STRING : undefined,
    // O banco do SAT usa charset NONE com textos gravados em Windows-1252; sem isso, acentos chegam como "�".
    encoding: (process.env.SAT_DB_ENCODING || "WIN1252") as Options["encoding"],
  };
  if (!options.database || !options.user || !options.password) throw new Error("ERP indisponível");
  const db = await new Promise<Database>((resolve, reject) => {
    attach(options, (err, connection) => err ? reject(err) : resolve(connection));
  });
  try {
    const tx = await new Promise<Transaction>((resolve, reject) => {
      db.transaction(ISOLATION_READ_COMMITTED_READ_ONLY, (err, transaction) => err ? reject(err) : resolve(transaction));
    });
    try {
      return await new Promise<T[]>((resolve, reject) => {
        tx.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows as T[]));
      });
    } finally {
      await new Promise<void>((resolve, reject) => tx.rollback(err => err ? reject(err) : resolve()));
    }
  } finally {
    db.detach();
  }
}

export function branchFilter(branches: Branches, column = "o.LOJA") {
  return branches ? ` AND ${column} IN (${branches.map(() => "?").join(",")})` : "";
}

export const validSale = "o.TIPO='V' AND (o.CANC IS NULL OR TRIM(o.CANC)='') AND (o.STATUS IS NULL OR o.STATUS=0)";
export const saleAmount = "CAST(COALESCE(o.TOTALDOPEDIDO,o.TOTAL) AS DECIMAL(15,2))";
export const clientPhone = "COALESCE(NULLIF(TRIM(c.TELR),''),NULLIF(TRIM(c.TEL1),''),NULLIF(TRIM(c.TEL2),''))";
export const clientFields = `c.CODCLI, TRIM(c.CLI) NOME, TRIM(c.CPF) CPF, TRIM(c.CIDR) CIDADE, ${clientPhone} TELEFONE, CAST(CAST(c.NAS AS DATE) AS VARCHAR(10)) NASCIMENTO`;

export function clientScope(branches: Branches) {
  return branches ? ` AND EXISTS (SELECT 1 FROM OE o WHERE o.CODCLI=c.CODCLI AND ${validSale}${branchFilter(branches)})` : "";
}

export function clientList(branches: Branches, search: string, city: string, limit: number, offset: number, sort: string) {
  const ordering = sort === "recent" ? "ULTIMA_COMPRA DESC NULLS LAST, c.CODCLI" :
    sort === "spent" ? "TOTAL_GASTO DESC, c.CODCLI" : "c.CLI, c.CODCLI";
  return readErp(`SELECT FIRST ? SKIP ? ${clientFields}, COUNT(o.ID_OE) COMPRAS,
    COALESCE(SUM(${saleAmount}),0) TOTAL_GASTO, CAST(CAST(MAX(o.DATA) AS DATE) AS VARCHAR(10)) ULTIMA_COMPRA,
    DATEDIFF(DAY FROM CAST(MAX(o.DATA) AS DATE) TO CURRENT_DATE) DIAS_SEM_COMPRAR
    FROM CLI c LEFT JOIN OE o ON o.CODCLI=c.CODCLI AND ${validSale}${branchFilter(branches)}
    WHERE (c.CLI CONTAINING ? OR c.CPF CONTAINING ? OR c.TELR CONTAINING ? OR c.TEL1 CONTAINING ? OR c.TEL2 CONTAINING ?)
    AND (CHAR_LENGTH(CAST(? AS VARCHAR(100)))=0 OR c.CIDR CONTAINING ?) ${clientScope(branches)}
    GROUP BY c.CODCLI,c.CLI,c.CPF,c.CIDR,c.TELR,c.TEL1,c.TEL2,c.NAS ORDER BY ${ordering}`,
    [limit, offset, ...(branches || []),search,search,search,search,search,city,city,...(branches || [])]);
}

export function clientSales(branches: Branches, client: number, offset: number) {
  return readErp(`SELECT FIRST 51 SKIP ? CAST(CAST(o.DATA AS DATE) AS VARCHAR(10)) DIA, o.ID_OE,o.LOJA,
    ${saleAmount} TOTAL, CAST(o.DESCONTO AS DECIMAL(15,2)) DESCONTO
    FROM OE o WHERE o.CODCLI=? AND ${validSale}${branchFilter(branches)} ORDER BY o.DATA DESC,o.ID_OE DESC`,
    [offset, client, ...(branches || [])]);
}
