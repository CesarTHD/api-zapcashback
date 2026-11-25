import { SatError } from "./access";
import { branchFilter, clientPhone, readErp } from "./erp";

type Scope = { branches: number[] | null };

/* Cashback nativo do ERP SAT (tabela CLIENTES_CASHBACK).
   STATUS (confirmado com a SAT): 0 = não resgatado ou parcialmente resgatado, 1 = resgatado, 2 = cancelado. Não existe 3. PRAZO = data de validade do crédito.
   A filial vem da venda de origem (OE.LOJA). Valores DOUBLE são arredondados para centavos linha a linha. */
const cbCredit = "COALESCE(cb.VALOR_CASHBACK,cb.VALOR,0)";
const cbRedeemed = "COALESCE(cb.VALOR_RESGATADO,0)";
const toCents = (expr: string) => `CAST(ROUND((${expr})*100,0) AS BIGINT)`;
export const cbExpired = "(cb.PRAZO IS NOT NULL AND CAST(cb.PRAZO AS DATE)<CURRENT_DATE)";
export const cbOpen = `cb.STATUS=0 AND ${cbCredit}-${cbRedeemed}>0`;
export const cbFrom = "FROM CLIENTES_CASHBACK cb LEFT JOIN OE o ON o.ID_OE=cb.ID_OE AND o.DATA=cb.DATA_OE";
/* Lista de movimentações: inclui nome e telefone do cliente (CLI). */
export const cbListFrom = `${cbFrom} LEFT JOIN CLI c ON c.CODCLI=cb.CODCLI`;
export const cbListFields = () => `${cbEntryFields}, TRIM(c.CLI) NOME, ${clientPhone} TELEFONE`;
export const cbStatusFilters: Record<string, string> = {
  disponível: `cb.STATUS=0 AND NOT ${cbExpired}`,
  expirado: `cb.STATUS=0 AND ${cbExpired}`,
  resgatado: "cb.STATUS=1",
  cancelado: "cb.STATUS=2",
  indefinido: "(cb.STATUS IS NULL OR cb.STATUS NOT IN (0,1,2))",
};
export const cbSummary = `COALESCE(SUM(${toCents(cbCredit)}),0) GENERATED,
  COALESCE(SUM(CASE WHEN ${cbOpen} AND NOT ${cbExpired} THEN ${toCents(`${cbCredit}-${cbRedeemed}`)} END),0) AVAILABLE,
  COALESCE(SUM(CASE WHEN ${cbOpen} AND ${cbExpired} THEN ${toCents(`${cbCredit}-${cbRedeemed}`)} END),0) EXPIRED,
  COALESCE(SUM(CASE WHEN cb.STATUS IN (0,1) THEN ${toCents(cbRedeemed)} END),0) REDEEMED`;
export const cbEntryFields = `cb.COD, o.LOJA, cb.CODCLI, CAST(CAST(cb.DATA_OE AS DATE) AS VARCHAR(10)) SALE_DATE, cb.ID_OE,
  ${toCents("COALESCE(cb.VALOR_VENDA,0)")} SALE_CENTS, ${toCents(cbCredit)} AMOUNT_CENTS, ${toCents(cbRedeemed)} REDEEMED_CENTS,
  ${toCents(`${cbCredit}-${cbRedeemed}`)} REMAINING_CENTS, CAST(CAST(cb.PRAZO AS DATE) AS VARCHAR(10)) EXPIRES_AT,
  cb.STATUS, CASE WHEN ${cbExpired} THEN 1 ELSE 0 END EXPIRED`;

type Summary = { GENERATED: string; AVAILABLE: string; EXPIRED: string; REDEEMED: string };
export const summaryRow = (row?: Partial<Summary>) => ({ generated: String(row?.GENERATED ?? 0),
  available: String(row?.AVAILABLE ?? 0), pending: "0", expired: String(row?.EXPIRED ?? 0), redeemed: String(row?.REDEEMED ?? 0) });

type Entry = { COD: number; LOJA: number | null; CODCLI: number; SALE_DATE: string; ID_OE: number; SALE_CENTS: string;
  AMOUNT_CENTS: string; REDEEMED_CENTS: string; REMAINING_CENTS: string; EXPIRES_AT: string | null; STATUS: number | null; EXPIRED: number;
  NOME?: string | null; TELEFONE?: string | null };
export const entryRow = (row: Entry) => ({ id: row.COD, branch: row.LOJA, customer: row.CODCLI, sale_date: row.SALE_DATE,
  sale_id: row.ID_OE, sale_cents: String(row.SALE_CENTS), amount_cents: String(row.AMOUNT_CENTS),
  redeemed_cents: String(row.REDEEMED_CENTS), remaining_cents: String(row.REMAINING_CENTS), expires_at: row.EXPIRES_AT,
  kind: "erp", source: "pdv", name: row.NOME ?? null, phone: row.TELEFONE ?? null,
  status: row.STATUS === 0 ? (row.EXPIRED ? "expirado" : "disponível") : row.STATUS === 1 ? "resgatado"
    : row.STATUS === 2 ? "cancelado" : "indefinido" });

export async function balances(scope: Scope, customers: number[]) {
  if (!customers.length) return new Map<number, ReturnType<typeof summaryRow>>();
  const rows = await readErp<Summary & { CODCLI: number }>(`SELECT cb.CODCLI, ${cbSummary} ${cbFrom}
    WHERE cb.CODCLI IN (${customers.map(() => "?").join(",")})${branchFilter(scope.branches)} GROUP BY cb.CODCLI`,
    [...customers, ...(scope.branches || [])], true);
  return new Map(rows.map(row => [row.CODCLI, summaryRow(row)]));
}

export async function expiringCredits(scope: Scope, customer: number) {
  const rows = await readErp<Entry>(`SELECT FIRST 10 ${cbEntryFields} ${cbFrom}
    WHERE cb.CODCLI=? AND ${cbOpen} AND NOT ${cbExpired}${branchFilter(scope.branches)}
    ORDER BY cb.PRAZO NULLS LAST, cb.COD`, [customer, ...(scope.branches || [])], true);
  return rows.map(row => ({ ...entryRow(row), amount_cents: String(row.REMAINING_CENTS) }));
}

/* Filtros de público por situação do cashback no ERP. Retorna os clientes de `customers` que atendem ao filtro. */
export const walletFilters = ["available","expiring","used","never_used"] as const;
export async function walletCustomers(scope: Scope, customers: number[], wallet: typeof walletFilters[number], expiryDays: number | null) {
  if (!customers.length) return new Set<number>();
  const having: Record<typeof walletFilters[number], string> = {
    available: `SUM(CASE WHEN ${cbOpen} AND NOT ${cbExpired} THEN 1 ELSE 0 END)>0`,
    expiring: `SUM(CASE WHEN ${cbOpen} AND NOT ${cbExpired} AND CAST(cb.PRAZO AS DATE)<=DATEADD(? DAY TO CURRENT_DATE) THEN 1 ELSE 0 END)>0`,
    used: `SUM(CASE WHEN ${cbRedeemed}>0 THEN 1 ELSE 0 END)>0`,
    never_used: `SUM(CASE WHEN ${cbRedeemed}>0 THEN 1 ELSE 0 END)=0`,
  };
  if (wallet === "expiring" && expiryDays === null) throw new SatError(400,"Informe os dias até o vencimento");
  const rows = await readErp<{ CODCLI: number }>(`SELECT cb.CODCLI ${cbFrom}
    WHERE cb.CODCLI IN (${customers.map(() => "?").join(",")})${branchFilter(scope.branches)}
    GROUP BY cb.CODCLI HAVING ${having[wallet]}`,
    [...customers, ...(scope.branches || []), ...(wallet === "expiring" ? [expiryDays as number] : [])]);
  return new Set(rows.map(row => row.CODCLI));
}

/* Eventos de automação sobre os créditos do ERP. `since` é o dia (São Paulo) em que a automação foi ativada. */
export type CreditEvent = "granted" | "released" | "expiring" | "expired";
export async function creditEventCandidates(customers: number[], event: CreditEvent, since: string, days: number) {
  if (!customers.length) return [];
  const conditions: Record<CreditEvent, [string, (string | number)[]]> = {
    granted: [`${cbOpen} AND NOT ${cbExpired} AND cb.DATA_OE>=CAST(? AS DATE)`, [since]],
    released: [`${cbOpen} AND NOT ${cbExpired} AND cb.DATA_OE>=CAST(? AS DATE)`, [since]],
    expiring: [`${cbOpen} AND NOT ${cbExpired} AND CAST(cb.PRAZO AS DATE)<=DATEADD(? DAY TO CURRENT_DATE)`, [days]],
    expired: [`${cbOpen} AND ${cbExpired} AND CAST(cb.PRAZO AS DATE)>=CAST(? AS DATE)`, [since]],
  };
  const [condition, params] = conditions[event];
  const rows = await readErp<{ COD: number; CODCLI: number }>(`SELECT cb.COD, cb.CODCLI FROM CLIENTES_CASHBACK cb
    WHERE cb.CODCLI IN (${customers.map(() => "?").join(",")}) AND ${condition} ORDER BY cb.COD`, [...customers, ...params]);
  return rows.map(row => ({ customer: row.CODCLI, event_key: `cb:${row.COD}` }));
}

/* Configuração de cashback por loja, mantida no próprio ERP SAT (tabela LOJAS). Somente leitura. */
export async function cashbackRules(scope: Scope) {
  const rows = await readErp<Record<string, unknown>>(`SELECT l.LOJA, TRIM(l.LOJAD) NOME, l.CASHBACK_ATIVO, l.ATIVARCASHBACK,
    ${toCents("COALESCE(l.CASHBACK_VALOR_MINIMO,0)")} MINIMO_CENTS, l.CASHBACK_PERCENTUAL, l.CASHBACK_PERCENTUAL_VENDA,
    l.CASHBACK_PRAZO FROM LOJAS l WHERE 1=1${branchFilter(scope.branches,"l.LOJA")} ORDER BY l.LOJA`,
    scope.branches || [], true);
  return rows.map(row => ({ branch: row.LOJA, name: row.NOME ?? null,
    enabled: String(row.CASHBACK_ATIVO ?? "").trim() === "S" || String(row.ATIVARCASHBACK ?? "").trim() === "S",
    percent: row.CASHBACK_PERCENTUAL == null ? null : Number(row.CASHBACK_PERCENTUAL),
    sale_percent: row.CASHBACK_PERCENTUAL_VENDA == null ? null : Number(row.CASHBACK_PERCENTUAL_VENDA),
    minimum_cents: String(row.MINIMO_CENTS ?? 0), validity_days: row.CASHBACK_PRAZO == null ? null : Number(row.CASHBACK_PRAZO) }));
}
