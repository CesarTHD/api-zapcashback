import { SatError } from "./access";
import { Branches, branchFilter, ErpQuery, readErp, validSale, writeErp } from "./erp";
import { balances, cbExpired, cbOpen } from "./cashback";
import { satDb } from "./store";

/* Lançamento e resgate de cashback gravados diretamente no ERP SAT, no mesmo formato usado pelo PDV:
   - lançamento: uma linha em CLIENTES_CASHBACK (STATUS 0) e OE.VALOR_CASHBACK_GERADO na venda;
   - resgate: consome créditos ativos e não vencidos do mais antigo para o mais novo (como CASHBACK_RESGATAR_*),
     marcando STATUS 1 quando o crédito é totalmente usado.
   O trigger CASHBACK do ERP mantém CLI.VALOR_CASHBACK a partir dessas linhas. Cada operação roda numa única
   transação, com bloqueio das linhas envolvidas, e é auditada no PostgreSQL (o ERP não registra o usuário). */

type Scope = { company: string; actor: string; branches: Branches };
type Credit = { code: number; cents: string };

const readQuery: ErpQuery = (sql, params = []) => readErp(sql, params, true);
const reais = (cents: bigint) => Number(cents) / 100;
const big = (value: unknown) => BigInt(String(value ?? 0));

function addDays(date: string, days: number) {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

type SaleRow = { CODCLI: number; LOJA: number; NOME: string | null; SALE_CENTS: string; DISCOUNT_CENTS: string;
  REDEEMED_CENTS: string; GENERATED_CENTS: string; HAS_RECORD: number; RETURNED: number; ATIVO: string | null;
  ATIVAR: string | null; BASIS_POINTS: string | number; MINIMUM_CENTS: string; VALIDITY: number | null };

/* O trigger CASHBACK soma o VALOR do crédito em CLI.VALOR_CASHBACK em todo UPDATE com STATUS 0 (inclusive no resgate
   parcial), o que infla o saldo que o PDV enxerga. Após cada operação, o saldo do cliente é recalculado a partir do que
   resta nos créditos ativos (sem considerar a validade, como o próprio ERP). */
async function syncCustomerBalance(query: ErpQuery, customer: number) {
  await query(`UPDATE CLI SET VALOR_CASHBACK=(SELECT ROUND(COALESCE(SUM(COALESCE(cb.VALOR_CASHBACK,cb.VALOR,0)-COALESCE(cb.VALOR_RESGATADO,0)),0),2)
    FROM CLIENTES_CASHBACK cb WHERE cb.CODCLI=CLI.CODCLI AND cb.STATUS=0) WHERE CODCLI=?`, [customer]);
}

async function quoteSale(query: ErpQuery, scope: Pick<Scope, "branches">, date: string, saleId: number) {
  const [sale] = await query<SaleRow>(`SELECT o.CODCLI, o.LOJA, TRIM(c.CLI) NOME,
    CAST(ROUND(COALESCE(o.TOTALDOPEDIDO,o.TOTAL,0)*100,0) AS BIGINT) SALE_CENTS,
    CAST(ROUND(COALESCE(o.DESCONTO,0)*100,0) AS BIGINT) DISCOUNT_CENTS,
    CAST(ROUND(COALESCE(o.VALOR_CASHBACK_RESGATADO,0)*100,0) AS BIGINT) REDEEMED_CENTS,
    CAST(ROUND(COALESCE(o.VALOR_CASHBACK_GERADO,0)*100,0) AS BIGINT) GENERATED_CENTS,
    CASE WHEN EXISTS (SELECT 1 FROM CLIENTES_CASHBACK cb WHERE cb.ID_OE=o.ID_OE AND cb.DATA_OE=o.DATA) THEN 1 ELSE 0 END HAS_RECORD,
    CASE WHEN EXISTS (SELECT 1 FROM IOE i WHERE i.DATA=o.DATA AND i.ID_OE=o.ID_OE
      AND (COALESCE(i.QUANT_DEVOLVIDO,0)>0 OR TRIM(i.DEVOLVIDO)='S' OR NULLIF(TRIM(i.CANC),'') IS NOT NULL)) THEN 1 ELSE 0 END RETURNED,
    TRIM(l.CASHBACK_ATIVO) ATIVO, TRIM(l.ATIVARCASHBACK) ATIVAR,
    CAST(ROUND(COALESCE(l.CASHBACK_PERCENTUAL,0)*100,0) AS INTEGER) BASIS_POINTS,
    CAST(ROUND(COALESCE(l.CASHBACK_VALOR_MINIMO,0)*100,0) AS BIGINT) MINIMUM_CENTS, l.CASHBACK_PRAZO VALIDITY
    FROM OE o JOIN CLI c ON c.CODCLI=o.CODCLI LEFT JOIN LOJAS l ON l.LOJA=o.LOJA
    WHERE o.DATA=CAST(? AS DATE) AND o.ID_OE=? AND ${validSale}${branchFilter(scope.branches)}`,
    [date, saleId, ...(scope.branches || [])]);
  if (!sale) throw new SatError(404, "Venda válida não encontrada para um cliente cadastrado");
  if (!Number.isInteger(sale.LOJA) || sale.LOJA <= 0) throw new SatError(409, "Venda sem loja válida");
  if (Number(sale.HAS_RECORD) || big(sale.GENERATED_CENTS) > 0n) throw new SatError(409, "Esta venda já tem cashback registrado no ERP");
  if (Number(sale.RETURNED)) throw new SatError(409, "Venda com devolução ou item cancelado");
  if (sale.ATIVO !== "S" && sale.ATIVAR !== "S") throw new SatError(409, `O cashback está desativado na loja ${sale.LOJA}`);
  const basisPoints = big(sale.BASIS_POINTS);
  const validity = Number(sale.VALIDITY);
  if (basisPoints <= 0n) throw new SatError(409, `Configure o percentual de cashback da loja ${sale.LOJA} no SAT`);
  if (!Number.isInteger(validity) || validity <= 0) throw new SatError(409, `Configure a validade do cashback da loja ${sale.LOJA} no SAT`);
  const saleCents = big(sale.SALE_CENTS);
  const redeemedCents = big(sale.REDEEMED_CENTS);
  // Base = valor pago, sem a parte quitada com cashback (VALOR_PAGO nos registros do PDV).
  const baseCents = saleCents - redeemedCents;
  if (baseCents <= 0n) throw new SatError(409, "Venda sem valor pago elegível");
  const minimumCents = big(sale.MINIMUM_CENTS);
  if (baseCents < minimumCents) throw new SatError(409, `Venda abaixo da compra mínima da loja (${reais(minimumCents).toFixed(2)})`);
  const creditCents = (baseCents * basisPoints + 5000n) / 10000n;
  if (creditCents <= 0n) throw new SatError(409, "Venda sem valor de cashback elegível");
  return { customer: sale.CODCLI, name: sale.NOME, branch: sale.LOJA, saleDate: date, saleId,
    saleCents: saleCents.toString(), discountCents: big(sale.DISCOUNT_CENTS).toString(), redeemedCents: redeemedCents.toString(),
    baseCents: baseCents.toString(), percent: Number(basisPoints) / 100, creditCents: creditCents.toString(),
    validityDays: validity, expiresOn: addDays(date, validity) };
}

export async function previewCredit(scope: Scope, date: string, saleId: number) {
  const quote = await quoteSale(readQuery, scope, date, saleId);
  const wallet = await balances({ branches: scope.branches }, [quote.customer]);
  return { ...quote, availableCents: wallet.get(quote.customer)?.available ?? "0" };
}

export async function launchCredit(scope: Scope, date: string, saleId: number, expectedCreditCents: string) {
  const result = await writeErp(async query => {
    // Bloqueia a venda: lançamentos simultâneos da mesma venda esperam um pelo outro e o segundo é recusado.
    const locked = await query(`SELECT o.ID_OE FROM OE o WHERE o.DATA=CAST(? AS DATE) AND o.ID_OE=? WITH LOCK`, [date, saleId]);
    if (!locked.length) throw new SatError(404, "Venda não encontrada");
    const quote = await quoteSale(query, scope, date, saleId);
    if (quote.creditCents !== expectedCreditCents) throw new SatError(409, "A venda ou a regra da loja mudou. Simule novamente antes de confirmar.");
    const credit = reais(BigInt(quote.creditCents));
    await query(`INSERT INTO CLIENTES_CASHBACK (CODCLI,ID_OE,DATA_OE,VALOR,STATUS,VALOR_VENDA,DESCONTO,VALOR_RESGATE,VALOR_PAGO,
      VALOR_CASHBACK,VALOR_RESGATADO,PRAZO)
      SELECT o.CODCLI,o.ID_OE,o.DATA,CAST(? AS DOUBLE PRECISION),0,CAST(? AS DOUBLE PRECISION),CAST(? AS DOUBLE PRECISION),
        CAST(? AS DOUBLE PRECISION),CAST(? AS DOUBLE PRECISION),CAST(? AS DOUBLE PRECISION),0,CAST(? AS DATE)
      FROM OE o WHERE o.DATA=CAST(? AS DATE) AND o.ID_OE=?`,
      [credit, reais(BigInt(quote.saleCents)), reais(BigInt(quote.discountCents)), reais(BigInt(quote.redeemedCents)),
        reais(BigInt(quote.baseCents)), credit, quote.expiresOn, date, saleId]);
    const [created] = await query<{ COD: number }>(`SELECT MAX(cb.COD) COD FROM CLIENTES_CASHBACK cb
      WHERE cb.ID_OE=? AND cb.DATA_OE=CAST(? AS DATE)`, [saleId, date]);
    await query(`UPDATE OE SET VALOR_CASHBACK_GERADO=CAST(? AS DOUBLE PRECISION) WHERE DATA=CAST(? AS DATE) AND ID_OE=?`,
      [credit, date, saleId]);
    await syncCustomerBalance(query, quote.customer);
    return { ...quote, code: created.COD };
  });
  const audited = await audit(scope, "credit", result.customer, BigInt(result.creditCents),
    [{ code: result.code, cents: result.creditCents }], null, result.branch, date, saleId);
  return { ...result, audited };
}

export async function redeemCredit(scope: Scope, customer: number, amountCents: bigint, reference: string | null) {
  const result = await writeErp(async query => {
    const candidates = await query<{ COD: number }>(`SELECT cb.COD FROM CLIENTES_CASHBACK cb
      LEFT JOIN OE o ON o.ID_OE=cb.ID_OE AND o.DATA=cb.DATA_OE
      WHERE cb.CODCLI=? AND ${cbOpen} AND NOT ${cbExpired}${branchFilter(scope.branches)} ORDER BY cb.ID_OE, cb.COD`,
      [customer, ...(scope.branches || [])]);
    const open: { code: number; remaining: bigint; redeemed: bigint }[] = [];
    for (const { COD } of candidates) {
      // Bloqueia cada crédito e relê o saldo: resgates simultâneos não consomem o mesmo valor.
      const [row] = await query<{ CREDIT_CENTS: string; REDEEMED_CENTS: string }>(`SELECT
        CAST(ROUND(COALESCE(cb.VALOR_CASHBACK,cb.VALOR,0)*100,0) AS BIGINT) CREDIT_CENTS,
        CAST(ROUND(COALESCE(cb.VALOR_RESGATADO,0)*100,0) AS BIGINT) REDEEMED_CENTS
        FROM CLIENTES_CASHBACK cb WHERE cb.COD=? AND ${cbOpen} AND NOT ${cbExpired} WITH LOCK`, [COD]);
      if (!row) continue;
      const remaining = big(row.CREDIT_CENTS) - big(row.REDEEMED_CENTS);
      if (remaining > 0n) open.push({ code: COD, remaining, redeemed: big(row.REDEEMED_CENTS) });
    }
    const available = open.reduce((sum, credit) => sum + credit.remaining, 0n);
    if (available < amountCents) {
      throw new SatError(409, `Saldo insuficiente. Disponível: ${reais(available).toFixed(2).replace(".", ",")}`);
    }
    let left = amountCents;
    const used: Credit[] = [];
    for (const credit of open) {
      if (left === 0n) break;
      const take = credit.remaining < left ? credit.remaining : left;
      if (take === credit.remaining) {
        await query(`UPDATE CLIENTES_CASHBACK SET STATUS=1, VALOR_RESGATADO=COALESCE(VALOR_CASHBACK,VALOR) WHERE COD=?`, [credit.code]);
      } else {
        await query(`UPDATE CLIENTES_CASHBACK SET VALOR_RESGATADO=CAST(? AS DOUBLE PRECISION) WHERE COD=?`,
          [reais(credit.redeemed + take), credit.code]);
      }
      used.push({ code: credit.code, cents: take.toString() });
      left -= take;
    }
    await syncCustomerBalance(query, customer);
    return { customer, redeemedCents: amountCents.toString(), availableBeforeCents: available.toString(),
      availableAfterCents: (available - amountCents).toString(), credits: used };
  });
  const audited = await audit(scope, "redemption", customer, amountCents, result.credits, reference);
  return { ...result, audited };
}

async function audit(scope: Scope, kind: "credit" | "redemption", customer: number, amount: bigint, credits: Credit[],
  reference: string | null, branch: number | null = null, saleDate: string | null = null, saleId: number | null = null) {
  if (!process.env.SAT_DATABASE_URL) return false;
  try {
    await satDb().query(`INSERT INTO sat_erp_operations
      (company,actor,kind,customer,branch,sale_date,sale_id,amount_cents,credits,reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [scope.company, scope.actor, kind, customer, branch, saleDate, saleId, amount.toString(), JSON.stringify(credits), reference]);
    return true;
  } catch (error) {
    // A gravação no ERP já foi confirmada; a falha de auditoria é registrada para conciliação manual.
    console.error("Falha ao auditar operação SAT no ERP", kind, customer, (error as { code?: string })?.code ?? "sem código");
    return false;
  }
}

export async function listOperations(scope: Scope, customer: number | null) {
  const { rows } = await satDb().query(`SELECT id,kind,customer,branch,to_char(sale_date,'YYYY-MM-DD') sale_date,sale_id,
    amount_cents,credits,reference,actor,created_at FROM sat_erp_operations
    WHERE company=$1 AND ($2::integer IS NULL OR customer=$2)
    AND ($3::integer[] IS NULL OR branch=ANY($3) OR actor=$4)
    ORDER BY id DESC LIMIT 20`, [scope.company, customer, scope.branches, scope.actor]);
  return rows;
}
