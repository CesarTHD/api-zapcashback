import { access, SatError } from "./access";
import { branchFilter, readErp, saleAmount, validSale } from "./erp";
import { satDb, transaction } from "./store";

type Scope = Pick<ReturnType<typeof access>, "company" | "actor" | "branches">;
type Sale = { CODCLI: number; LOJA: number; CENTS: string | number | null; LEGACY: number; RETURNED: number };

export function calculateCredit(cents: bigint, basisPoints: number, maximum: bigint) {
  const credit = (cents * BigInt(basisPoints) + 5000n) / 10000n;
  return credit > maximum ? maximum : credit;
}

export async function grant(scope: Scope, date: string, saleId: number, preview: boolean, source: "manual" | "automatic",
  expected?: { saleCents: string; creditCents: string }) {
  const [sale] = await readErp<Sale>(`SELECT o.CODCLI, o.LOJA, CAST(${saleAmount} * 100 AS DECIMAL(17,0)) CENTS,
    CASE WHEN COALESCE(o.VALOR_CASHBACK_GERADO,0)>0 OR COALESCE(o.VALOR_CASHBACK_NUMMUS,0)>0
      OR COALESCE(o.VALOR_CASHBACK,0)>0 OR EXISTS (SELECT 1 FROM CLIENTES_CASHBACK cb
      WHERE cb.ID_OE=o.ID_OE AND cb.DATA_OE=o.DATA) THEN 1 ELSE 0 END LEGACY,
    CASE WHEN EXISTS (SELECT 1 FROM IOE i WHERE i.DATA=o.DATA AND i.ID_OE=o.ID_OE
      AND (COALESCE(i.QUANT_DEVOLVIDO,0)>0 OR TRIM(i.DEVOLVIDO)='S'
      OR NULLIF(TRIM(i.CANC),'') IS NOT NULL)) THEN 1 ELSE 0 END RETURNED
    FROM OE o JOIN CLI c ON c.CODCLI=o.CODCLI
    WHERE o.DATA=CAST(? AS DATE) AND o.ID_OE=? AND ${validSale}${branchFilter(scope.branches)}`,
    [date, saleId, ...(scope.branches || [])], true);
  if (!sale || !Number.isInteger(sale.LOJA) || sale.LOJA <= 0) throw new SatError(404, "Venda elegível não encontrada");
  if (sale.LEGACY || sale.RETURNED) throw new SatError(409, "Venda com cashback legado, devolução ou item cancelado");
  if (sale.CENTS === null || !/^\d+$/.test(String(sale.CENTS))) throw new SatError(409, "Valor da venda inválido");
  const cents = BigInt(sale.CENTS);
  if (cents <= 0n) throw new SatError(409, "Valor da venda inválido");
  return transaction(async db => {
    const { rows: [rule] } = await db.query(
      `SELECT *, to_char(starts_on,'YYYY-MM-DD') start_day
       FROM sat_rules WHERE company=$1 AND branch IN (0,$2)
       ORDER BY branch DESC LIMIT 1 FOR SHARE`, [scope.company, sale.LOJA]);
    if (!rule?.enabled || date < rule.start_day || cents < BigInt(rule.minimum_cents)) {
      throw new SatError(409, "Venda fora da regra vigente de cashback");
    }
    const credit = calculateCredit(cents, rule.basis_points, BigInt(rule.maximum_cents));
    if (credit <= 0n) throw new SatError(409, "Venda sem valor de cashback elegível");
    if (expected && (expected.saleCents !== cents.toString() || expected.creditCents !== credit.toString())) {
      throw new SatError(409,"A venda ou a regra mudou. Simule novamente antes de confirmar.");
    }
    const params = [scope.company, sale.LOJA, sale.CODCLI, date, saleId, cents.toString(), credit.toString(),
      source, scope.actor, rule.delay_days, rule.validity_days];
    const { rows: [existing] } = await db.query(
      "SELECT id,amount_cents FROM sat_ledger WHERE company=$1 AND sale_date=$2 AND sale_id=$3 AND kind='credit'",
      [scope.company, date, saleId]);
    if (existing) throw new SatError(409, "Cashback já registrado para a venda");
    const quote = { saleCents: cents.toString(), creditCents: credit.toString(), customer: sale.CODCLI, branch: sale.LOJA };
    if (preview) return quote;
    const { rows: [created] } = await db.query<{ id: string; amount_cents: string }>(`INSERT INTO sat_ledger
      (company,branch,customer,sale_date,sale_id,sale_cents,amount_cents,kind,source,actor,available_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'credit',$8,$9,
      GREATEST(now(),(($4::date+$10::integer)::timestamp AT TIME ZONE 'America/Sao_Paulo')),
      GREATEST(now(),(($4::date+$10::integer)::timestamp AT TIME ZONE 'America/Sao_Paulo'))+$11::integer*interval '1 day')
      ON CONFLICT (company,sale_date,sale_id,kind) DO NOTHING RETURNING id,amount_cents`, params);
    if (!created) throw new SatError(409, "Cashback já registrado para a venda");
    return { ...quote, ...created };
  });
}

export async function balances(scope: Scope, customers: number[]) {
  if (!customers.length) return new Map();
  const { rows } = await satDb().query(`SELECT customer,
    SUM(amount_cents) generated,
    COALESCE(SUM(amount_cents) FILTER (WHERE NOT reversed AND available_at<=now() AND expires_at>now()),0) available,
    COALESCE(SUM(amount_cents) FILTER (WHERE NOT reversed AND available_at>now()),0) pending,
    COALESCE(SUM(amount_cents) FILTER (WHERE NOT reversed AND expires_at<=now()),0) expired
    FROM (SELECT l.*,EXISTS (SELECT 1 FROM sat_ledger r WHERE r.company=l.company AND r.sale_date=l.sale_date
      AND r.sale_id=l.sale_id AND r.kind='reversal') AS reversed
      FROM sat_ledger l WHERE company=$1 AND customer=ANY($2::integer[])
      AND ($3::integer[] IS NULL OR branch=ANY($3)) AND kind='credit') credits GROUP BY customer`,
    [scope.company, customers, scope.branches]);
  return new Map(rows.map(row => [row.customer, row]));
}

export async function processSales(scope: Scope, date: string, after: number) {
  const batch = await readErp<{ ID_OE: number }>(`SELECT FIRST 51 o.ID_OE FROM OE o
    WHERE o.DATA=CAST(? AS DATE) AND o.ID_OE>? AND ${validSale}${branchFilter(scope.branches)} ORDER BY o.ID_OE`,
    [date,after,...(scope.branches || [])]);
  let created = 0;
  let skipped = 0;
  for (const sale of batch.slice(0,50)) {
    try {
      await grant(scope,date,sale.ID_OE,false,"automatic");
      created++;
    } catch (error) {
      if (!(error instanceof SatError) || ![404,409].includes(error.status)) throw error;
      skipped++;
    }
  }
  return { created, skipped, next: batch.length>50 ? batch[49]?.ID_OE : null };
}

export function startSatGeneration() {
  const company = process.env.SAT_COMPANY_ID;
  const actor = process.env.SAT_AUTO_GRANT_ACTOR;
  if (!company || !actor) return;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor)) {
    console.error("Identificador do ator de geração SAT inválido");
    return;
  }
  const days = Number(process.env.SAT_AUTO_GRANT_LOOKBACK_DAYS || 3);
  if (!Number.isSafeInteger(days) || days<1 || days>30) {
    console.error("Janela de geração SAT inválida");
    return;
  }
  const formatter = new Intl.DateTimeFormat("sv-SE",{ timeZone:"America/Sao_Paulo" });
  let running = false;
  let cursor = 0;
  let offset = 0;
  let cycleDay = "";
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const today = formatter.format(now);
      if (cycleDay !== today) {
        cycleDay = today;
        cursor = 0;
        offset = 0;
      }
      const date = formatter.format(now-offset*86400000);
      const result = await processSales({ company, actor, branches:null },date,cursor);
      cursor = result.next ?? 0;
      if (!result.next) offset = (offset+1)%days;
    } catch (error) {
      console.error("Falha na geração automática SAT",(error as { code?: string })?.code ?? "sem código");
    } finally { running = false; }
  },60000).unref();
}
