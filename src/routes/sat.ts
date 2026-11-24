import { Router, ErrorRequestHandler } from "express";
import auth from "../middleware/authMiddleware";
import { access, day, integer, SatError } from "../sat/access";
import { branchFilter, clientFields, clientList, clientPhone, clientSales, clientScope, readErp, saleAmount, validSale } from "../sat/erp";
import { balances, grant, processSales } from "../sat/cashback";
import { satDb } from "../sat/store";
import { normalizeBrazilianPhone, selectAudience } from "../sat/audience";
import { queueCampaign } from "../sat/messaging";
import { automationEvents } from "../sat/automations";

const router = Router();
router.use(auth);
const input = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 100) : "";

router.get("/access", (req, res) => {
  const scope = access(req);
  res.json({ role: scope.role, branches: scope.branches });
});

router.post("/audiences/preview", async (req, res) => {
  const customers = await selectAudience(access(req,"operator"), req.body ?? {});
  res.json({ count: customers.length });
});

router.post("/campaigns", async (req, res) => {
  res.status(201).json(await queueCampaign(access(req,"operator"),req.body ?? {}));
});

router.get("/campaigns", async (req, res) => {
  const scope = access(req,"operator");
  const { rows } = await satDb().query(`SELECT c.id,c.name,c.schedule_at,count(q.id) total,
    count(*) FILTER (WHERE q.status='queued') queued,count(*) FILTER (WHERE q.status='accepted') accepted,
    count(*) FILTER (WHERE q.status='failed') failed,count(*) FILTER (WHERE q.status='skipped') skipped,
    count(*) FILTER (WHERE q.status='unknown') unknown,count(*) FILTER (WHERE q.status='sending') sending
    FROM sat_campaigns c LEFT JOIN sat_message_queue q ON q.campaign=c.id
    WHERE c.company=$1 AND c.actor=$2 AND ($3::integer[] IS NULL OR c.branches<@$3)
    GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50`, [scope.company,scope.actor,scope.branches]);
  res.json({ rows });
});

router.get("/campaigns/:id/messages", async (req, res) => {
  const scope = access(req,"operator");
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new SatError(400,"Identificador inválido");
  const offset = integer(req.query.offset ?? 0,0,1000);
  const { rows } = await satDb().query(`SELECT q.customer,q.status,q.attempts,q.attempted_at,q.provider_status
    FROM sat_campaigns c JOIN sat_message_queue q ON q.campaign=c.id
    WHERE c.company=$1 AND c.actor=$2 AND ($3::integer[] IS NULL OR c.branches<@$3) AND c.id::text=$4
    ORDER BY q.id LIMIT 51 OFFSET $5`, [scope.company,scope.actor,scope.branches,req.params.id,offset]);
  res.json({ rows: rows.slice(0,50), more: rows.length>50 });
});

router.get("/automations", async (req, res) => {
  const scope = access(req,"admin");
  if (scope.branches) throw new SatError(403,"Automações são configuradas no escopo da rede");
  const { rows } = await satDb().query("SELECT event,enabled,days,template FROM sat_automations WHERE company=$1 ORDER BY event", [scope.company]);
  res.json({ rows });
});

router.put("/automations/:event", async (req, res) => {
  const scope = access(req,"admin");
  if (scope.branches) throw new SatError(403,"Automações são configuradas no escopo da rede");
  const event = automationEvents.find(name => name === req.params.event);
  const { enabled, days, template } = req.body ?? {};
  if (!event || typeof enabled !== "boolean" || typeof template !== "string" || !template.trim() || template.length>2000) {
    throw new SatError(400,"Configuração de automação inválida");
  }
  await satDb().query(`INSERT INTO sat_automations (company,event,enabled,days,template,actor)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(company,event) DO UPDATE SET enabled=excluded.enabled,
    days=excluded.days,template=excluded.template,actor=excluded.actor,
    active_since=CASE WHEN excluded.enabled AND NOT sat_automations.enabled THEN now() ELSE sat_automations.active_since END`,
    [scope.company,event,enabled,integer(days,1,3650),template.trim(),scope.actor]);
  res.sendStatus(204);
});

router.get("/clients", async (req, res) => {
  const scope = access(req);
  const offset = integer(req.query.offset ?? 0, 0, 1000000);
  const rows = await clientList(scope.branches, input(req.query.q), input(req.query.city), 51, offset, input(req.query.sort));
  const visible = rows.slice(0, 50) as { CODCLI: number }[];
  if (process.env.SAT_DATABASE_URL) {
    const [wallets, consent] = await Promise.all([
      balances(scope, visible.map(row => row.CODCLI)),
      satDb().query("SELECT customer,promotional,opted_out FROM sat_consent WHERE company=$1 AND customer=ANY($2::integer[])", [
        scope.company,visible.map(row => row.CODCLI),
      ]),
    ]);
    const permissions = new Map(consent.rows.map(row => [row.customer,row]));
    res.json({ rows: visible.map(row => {
      const permission = permissions.get(row.CODCLI);
      return { ...row, AVAILABLE: wallets.get(row.CODCLI)?.available ?? "0",
        WHATSAPP: permission?.opted_out ? "Descadastrado" : permission?.promotional ? "Autorizado" : "Sem autorização registrada" };
    }), more: rows.length > 50 });
    return;
  }
  res.json({ rows: visible, more: rows.length > 50 });
});

router.get("/clients/export.csv", async (req, res) => {
  const scope = access(req);
  const rows = await clientList(scope.branches, input(req.query.q), input(req.query.city), 5001, 0, input(req.query.sort));
  if (rows.length > 5000) throw new SatError(400,"Refine os filtros para exportar até 5.000 clientes");
  const fields = ["CODCLI","NOME","CPF","CIDADE","TELEFONE","NASCIMENTO","COMPRAS","TOTAL_GASTO","ULTIMA_COMPRA","DIAS_SEM_COMPRAR"];
  const escape = (value: unknown) => {
    const string = String(value ?? "");
    return '"' + (/^[\s]*[=+\-@]/.test(string) || /^[\r\n\t]/.test(string) ? "'" : "") + string.replace(/"/g,'""') + '"';
  };
  res.attachment("clientes-sat.csv").type("text/csv").send("\uFEFF" + [fields.join(";"), ...rows.map(row =>
    fields.map(f => escape((row as Record<string, unknown>)[f])).join(";"))].join("\r\n"));
});

router.get("/clients/:id", async (req, res) => {
  const scope = access(req);
  const id = integer(req.params.id, 0, 2147483647);
  const offset = integer(req.query.offset ?? 0, 0, 1000000);
  const [client] = await readErp(`SELECT ${clientFields} FROM CLI c WHERE c.CODCLI=? ${clientScope(scope.branches)}`,
    [id, ...(scope.branches || [])]);
  if (!client) throw new SatError(404, "Cliente não encontrado");
  const [sales, [metrics]] = await Promise.all([
    clientSales(scope.branches, id, offset),
    readErp(`SELECT COUNT(*) COMPRAS, COALESCE(SUM(${saleAmount}),0) TOTAL_GASTO,
      CAST(CAST(MAX(o.DATA) AS DATE) AS VARCHAR(10)) ULTIMA_COMPRA,
      DATEDIFF(DAY FROM CAST(MAX(o.DATA) AS DATE) TO CURRENT_DATE) DIAS_SEM_COMPRAR,
      AVG(${saleAmount}) TICKET_MEDIO,
      (DATEDIFF(DAY FROM CAST(MIN(o.DATA) AS DATE) TO CAST(MAX(o.DATA) AS DATE))*1.0)
         /NULLIF(COUNT(*)-1,0) FREQUENCIA
      FROM OE o WHERE o.CODCLI=? AND ${validSale}${branchFilter(scope.branches)}`, [id, ...(scope.branches || [])]),
  ]);
  res.json({ client, metrics, sales: sales.slice(0,50), more: sales.length > 50 });
});

router.get("/clients/:id/sales/:date/:sale/items", async (req, res) => {
  const scope = access(req);
  const rows = await readErp(`SELECT FIRST 101 SKIP ? i.ID_ITEM,i.COD,TRIM(i.CLI) NOME,i.QUANT,
    CAST(i.VALORTOTAL AS DECIMAL(15,2)) TOTAL,i.CANC,i.QUANT_DEVOLVIDO
    FROM OE o JOIN IOE i ON i.DATA=o.DATA AND i.ID_OE=o.ID_OE
    WHERE o.CODCLI=? AND o.DATA=CAST(? AS DATE) AND o.ID_OE=? AND ${validSale}${branchFilter(scope.branches)}
    ORDER BY i.ID_ITEM`, [integer(req.query.offset ?? 0,0,1000000),integer(req.params.id,0,2147483647),
    day(req.params.date),integer(req.params.sale,0,2147483647),...(scope.branches || [])]);
  res.json({ rows: rows.slice(0,100), more: rows.length>100 });
});

router.get("/clients/:id/cashback", async (req, res) => {
  const scope = access(req);
  const id = integer(req.params.id,0,2147483647);
  const [customer] = await readErp(`SELECT c.CODCLI FROM CLI c WHERE c.CODCLI=? ${clientScope(scope.branches)}`,
    [id,...(scope.branches || [])]);
  if (!customer) throw new SatError(404,"Cliente não encontrado");
  const [map, consent, credits, messages] = await Promise.all([
    balances(scope,[id]),
    satDb().query("SELECT promotional,transactional,opted_out FROM sat_consent WHERE company=$1 AND customer=$2", [scope.company,id]),
    satDb().query(`SELECT l.id,l.branch,l.amount_cents,l.expires_at FROM sat_ledger l
      WHERE l.company=$1 AND l.customer=$2 AND ($3::integer[] IS NULL OR l.branch=ANY($3))
      AND l.kind='credit' AND l.available_at<=now() AND l.expires_at>now()
      AND NOT EXISTS (SELECT 1 FROM sat_ledger r WHERE r.company=l.company AND r.sale_date=l.sale_date AND r.sale_id=l.sale_id
        AND r.kind='reversal') ORDER BY l.expires_at LIMIT 10`, [scope.company,id,scope.branches]),
    satDb().query(`SELECT q.id,q.status,q.attempted_at,q.provider_status,c.name FROM sat_message_queue q
      JOIN sat_campaigns c ON c.id=q.campaign WHERE c.company=$1 AND q.customer=$2
      AND ($3::integer[] IS NULL OR c.branches<@$3) ORDER BY q.id DESC LIMIT 20`, [scope.company,id,scope.branches]),
  ]);
  res.json({ balance: map.get(id) ?? { available: "0", pending: "0", expired: "0", generated: "0" },
    consent: consent.rows[0] ?? null, credits: credits.rows, messages: messages.rows });
});

router.put("/clients/:id/consent", async (req, res) => {
  const scope = access(req,"admin");
  if (scope.branches) throw new SatError(403,"Consentimento compartilhado exige acesso à rede");
  const id = integer(req.params.id,0,2147483647);
  const [customer] = await readErp<{ PHONE: string | null }>(`SELECT ${clientPhone} PHONE FROM CLI c WHERE CODCLI=?`, [id]);
  if (!customer) throw new SatError(404,"Cliente não encontrado");
  const { promotional, transactional, optedOut } = req.body ?? {};
  const phone = customer.PHONE ? normalizeBrazilianPhone(customer.PHONE) : null;
  const evidence = input(req.body?.evidence);
  if ([promotional,transactional,optedOut].some(value => typeof value !== "boolean") || !evidence ||
    (optedOut && (promotional || transactional))) throw new SatError(400,"Informe as autorizações e a referência da evidência");
  if (!phone && (promotional || transactional)) throw new SatError(400,"Cliente sem telefone brasileiro válido no ERP");
  await satDb().query(`WITH recorded AS (INSERT INTO sat_consent_audit
    (company,customer,actor,promotional,transactional,opted_out,evidence,phone)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *)
    INSERT INTO sat_consent (company,customer,promotional,transactional,opted_out,phone)
    SELECT company,customer,promotional,transactional,opted_out,phone FROM recorded
    ON CONFLICT(company,customer) DO UPDATE SET promotional=excluded.promotional,
    transactional=excluded.transactional,opted_out=excluded.opted_out,phone=excluded.phone`,
    [scope.company,id,scope.actor,promotional,transactional,optedOut,evidence,phone]);
  res.sendStatus(204);
});

router.get("/dashboard", async (req, res) => {
  const scope = access(req);
  const start = day(req.query.start);
  const end = day(req.query.end);
  const span = (+new Date(end) - +new Date(start)) / 86400000;
  if (span < 0 || span > 365) throw new SatError(400, "Selecione até 366 dias");
  const branch = req.query.branch === undefined ? undefined : integer(req.query.branch,1,32767);
  if (branch && scope.branches && !scope.branches.includes(branch)) throw new SatError(403, "Filial não autorizada");
  const branches = branch ? [branch] : scope.branches;
  const [daily, hours, [totals], [last], [cohorts], [prior]] = await Promise.all([
    readErp(`SELECT CAST(CAST(o.DATA AS DATE) AS VARCHAR(10)) DIA, EXTRACT(WEEKDAY FROM o.DATA) SEMANA,
      COUNT(*) VENDAS,SUM(${saleAmount}) TOTAL FROM OE o
      WHERE o.DATA>=CAST(? AS DATE) AND o.DATA<DATEADD(1 DAY TO CAST(? AS DATE))
      AND ${validSale}${branchFilter(branches)} GROUP BY 1,2 ORDER BY 1`, [start,end,...(branches || [])]),
    readErp(`SELECT EXTRACT(HOUR FROM o.HORA) HORA,SUM(${saleAmount}) TOTAL FROM OE o
      WHERE o.DATA>=CAST(? AS DATE) AND o.DATA<DATEADD(1 DAY TO CAST(? AS DATE))
      AND o.HORA IS NOT NULL AND ${validSale}${branchFilter(branches)} GROUP BY 1 ORDER BY 1`, [start,end,...(branches || [])]),
    readErp(`SELECT COUNT(*) VENDAS,SUM(${saleAmount}) TOTAL,AVG(${saleAmount}) TICKET_MEDIO,
      COUNT(DISTINCT c.CODCLI) CLIENTES, COUNT(CASE WHEN o.VALOR_CASHBACK_RESGATADO>0 THEN 1 END) VENDAS_COM_CASHBACK
      FROM OE o LEFT JOIN CLI c ON c.CODCLI=o.CODCLI
      WHERE o.DATA>=CAST(? AS DATE) AND o.DATA<DATEADD(1 DAY TO CAST(? AS DATE))
      AND ${validSale}${branchFilter(branches)}`, [start,end,...(branches || [])]),
    readErp(`SELECT CAST(CAST(MAX(o.DATA) AS DATE) AS VARCHAR(10)) ULTIMA_VENDA FROM OE o
      WHERE ${validSale}${branchFilter(branches)}`, branches || []),
    readErp(`SELECT COUNT(CASE WHEN FIRST_SALE>=CAST(? AS DATE) AND PERIOD_SALES>0 THEN 1 END) NOVOS,
      COUNT(CASE WHEN FIRST_SALE<CAST(? AS DATE) AND PERIOD_SALES>0 THEN 1 END) RECORRENTES,
      COUNT(CASE WHEN PERIOD_SALES>=2 THEN 1 END) RECOMPRA,
      COUNT(CASE WHEN PERIOD_SALES=0 AND LAST_SALE>=DATEADD(? DAY TO CAST(? AS DATE)) THEN 1 END) INATIVOS
      FROM (SELECT MIN(o.DATA) FIRST_SALE,MAX(o.DATA) LAST_SALE,
        COUNT(CASE WHEN o.DATA>=CAST(? AS DATE) THEN 1 END) PERIOD_SALES
        FROM OE o JOIN CLI c ON c.CODCLI=o.CODCLI WHERE o.DATA<DATEADD(1 DAY TO CAST(? AS DATE))
        AND ${validSale}${branchFilter(branches)} GROUP BY c.CODCLI) activity`, [start,start,-(span+1),start,start,end,...(branches || [])]),
    readErp(`SELECT COUNT(*) VENDAS,SUM(${saleAmount}) TOTAL FROM OE o
      WHERE o.DATA>=DATEADD(? DAY TO CAST(? AS DATE)) AND o.DATA<CAST(? AS DATE)
      AND ${validSale}${branchFilter(branches)}`, [-(span+1),start,start,...(branches || [])]),
  ]);
  res.json({ daily, hours, totals, last, cohorts, prior });
});

router.get("/dashboard/cashback", async (req, res) => {
  const scope = access(req);
  const start = day(req.query.start);
  const end = day(req.query.end);
  const span = (+new Date(end) - +new Date(start)) / 86400000;
  if (span < 0 || span > 365) throw new SatError(400,"Selecione até 366 dias");
  const branch = req.query.branch === undefined ? undefined : integer(req.query.branch,1,32767);
  if (branch && scope.branches && !scope.branches.includes(branch)) throw new SatError(403,"Filial não autorizada");
  const { rows } = await satDb().query(`WITH credit AS (
    SELECT l.*, CAST(l.created_at AT TIME ZONE 'America/Sao_Paulo' AS date) event_day,
      EXISTS (SELECT 1 FROM sat_ledger r WHERE r.company=l.company AND r.sale_date=l.sale_date AND
        r.sale_id=l.sale_id AND r.kind='reversal') reversed
    FROM sat_ledger l WHERE company=$1 AND ($2::integer[] IS NULL OR branch=ANY($2)) AND kind='credit'
    AND l.created_at >= ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND l.created_at < (($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    SELECT to_char(event_day,'YYYY-MM-DD') AS day, SUM(amount_cents) AS generated,
      COALESCE(SUM(amount_cents) FILTER (WHERE NOT reversed AND available_at<=now() AND expires_at>now()),0) available,
      COALESCE(SUM(amount_cents) FILTER (WHERE NOT reversed AND available_at>now()),0) pending,
      COALESCE(SUM(amount_cents) FILTER (WHERE NOT reversed AND expires_at<=now()),0) expired
    FROM credit GROUP BY event_day ORDER BY event_day`, [scope.company,branch ? [branch] : scope.branches,start,end]);
  res.json({ rows });
});

router.get("/cashback", async (req, res) => {
  const scope = access(req);
  const customer = req.query.customer === undefined ? null : integer(req.query.customer,0,2147483647);
  const offset = integer(req.query.offset ?? 0,0,1000000);
  const branch = req.query.branch === undefined ? null : integer(req.query.branch,1,32767);
  if (branch && scope.branches && !scope.branches.includes(branch)) throw new SatError(403,"Filial não autorizada");
  const start = req.query.start === undefined ? null : day(req.query.start);
  const end = req.query.end === undefined ? null : day(req.query.end);
  if (start && end && start>end) throw new SatError(400,"Período inválido");
  const status = req.query.status === undefined ? null : input(req.query.status);
  if (status !== null && !["disponível","pendente","expirado","estornado","estorno"].includes(status)) {
    throw new SatError(400,"Status inválido");
  }
  const { rows } = await satDb().query(`WITH entries AS (SELECT l.id,branch,customer,to_char(sale_date,'YYYY-MM-DD') sale_date,
    sale_id,sale_cents,amount_cents,kind,source,created_at,available_at,expires_at,
    CASE WHEN kind='reversal' THEN 'estorno' WHEN EXISTS (SELECT 1 FROM sat_ledger r WHERE
      r.company=l.company AND r.sale_date=l.sale_date AND r.sale_id=l.sale_id AND r.kind='reversal')
      THEN 'estornado' WHEN expires_at<=now() THEN 'expirado' WHEN available_at>now() THEN 'pendente'
      ELSE 'disponível' END status
    FROM sat_ledger l WHERE company=$1 AND ($2::integer[] IS NULL OR branch=ANY($2))
    AND ($3::integer IS NULL OR customer=$3) AND ($5::date IS NULL OR sale_date >= $5)
    AND ($6::date IS NULL OR sale_date <= $6))
    SELECT * FROM entries WHERE ($7::text IS NULL OR status=$7) ORDER BY id DESC LIMIT 51 OFFSET $4`,
    [scope.company,branch ? [branch] : scope.branches,customer,offset,start,end,status]);
  res.json({ rows: rows.slice(0,50), more: rows.length>50 });
});

router.get("/rules", async (req, res) => {
  const scope = access(req,"admin");
  const { rows } = await satDb().query(`SELECT branch,enabled,basis_points,minimum_cents,maximum_cents,delay_days,
    validity_days,to_char(starts_on,'YYYY-MM-DD') starts_on,redemption_limit_cents,redemption_basis_points
    FROM sat_rules WHERE company=$1 AND ($2::integer[] IS NULL OR branch=ANY($2)) ORDER BY branch`,
    [scope.company,scope.branches]);
  res.json({ rows });
});

router.post("/cashback/preview", async (req, res) => {
  const scope = access(req,"operator");
  const preview = await grant(scope,day(req.body?.date),integer(req.body?.saleId,0,2147483647),true,"manual");
  const wallets = await balances({ ...scope, branches:[preview.branch] },[preview.customer]);
  res.json({ ...preview, availableCents: wallets.get(preview.customer)?.available ?? "0" });
});

router.post("/cashback", async (req, res) => {
  const scope = access(req,"operator");
  const { saleCents, creditCents } = req.body ?? {};
  if ([saleCents, creditCents].some(value => typeof value !== "string" || !/^\d{1,17}$/.test(value))) {
    throw new SatError(400,"Simule o cashback antes de confirmar");
  }
  res.status(201).json(await grant(scope,day(req.body?.date),integer(req.body?.saleId,0,2147483647),false,"manual",
    { saleCents, creditCents }));
});

router.post("/cashback/process", async (req, res) => {
  const scope = access(req,"admin");
  const date = day(req.body?.date);
  const after = integer(req.body?.after ?? 0,0,2147483647);
  res.json(await processSales(scope,date,after));
});

router.post("/cashback/:id/reversal", async (req, res) => {
  const scope = access(req,"admin");
  const id = integer(req.params.id,1,Number.MAX_SAFE_INTEGER);
  const { rows: [entry] } = await satDb().query(`INSERT INTO sat_ledger
    (company,branch,customer,sale_date,sale_id,sale_cents,amount_cents,kind,source,actor,available_at,expires_at)
    SELECT company,branch,customer,sale_date,sale_id,sale_cents,amount_cents,'reversal','manual',$4,available_at,expires_at
    FROM sat_ledger WHERE company=$1 AND id=$2 AND kind='credit' AND ($3::integer[] IS NULL OR branch=ANY($3))
    ON CONFLICT (company,sale_date,sale_id,kind) DO NOTHING RETURNING id`, [scope.company,id,scope.branches,scope.actor]);
  if (!entry) throw new SatError(409,"Crédito indisponível para estorno");
  res.status(201).json(entry);
});

router.put("/rules/:branch", async (req, res) => {
  const scope = access(req,"admin");
  const branch = integer(req.params.branch,0,32767);
  if (scope.branches && !scope.branches.includes(branch)) throw new SatError(403,"Filial não autorizada");
  const { enabled, basisPoints, minimumCents, maximumCents, delayDays, validityDays, startsOn,
    redemptionLimitCents, redemptionBasisPoints } = req.body ?? {};
  if (typeof enabled !== "boolean") throw new SatError(400,"Estado do programa inválido");
  await satDb().query(`INSERT INTO sat_rules (company,branch,enabled,basis_points,minimum_cents,maximum_cents,delay_days,validity_days,starts_on,redemption_limit_cents,redemption_basis_points)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(company,branch) DO UPDATE SET
    enabled=excluded.enabled,basis_points=excluded.basis_points,minimum_cents=excluded.minimum_cents,
    maximum_cents=excluded.maximum_cents,delay_days=excluded.delay_days,validity_days=excluded.validity_days,
    starts_on=excluded.starts_on,redemption_limit_cents=excluded.redemption_limit_cents,
    redemption_basis_points=excluded.redemption_basis_points`, [scope.company,branch,enabled,integer(basisPoints,0,10000),
    integer(minimumCents,0,Number.MAX_SAFE_INTEGER),integer(maximumCents,1,Number.MAX_SAFE_INTEGER),
    integer(delayDays,0,365),integer(validityDays,1,3650),day(startsOn),
    redemptionLimitCents == null ? null : integer(redemptionLimitCents,1,Number.MAX_SAFE_INTEGER),
    redemptionBasisPoints == null ? null : integer(redemptionBasisPoints,1,10000)]);
  res.sendStatus(204);
});

router.post("/redemptions/authorize", async (req, res) => {
  const scope = access(req,"pdv");
  const branch = integer(req.body?.branch,1,32767);
  if (scope.branches && !scope.branches.includes(branch)) throw new SatError(403,"Filial não autorizada");
  const customer = integer(req.body?.customer,0,2147483647);
  const orderCents = integer(req.body?.orderCents,1,Number.MAX_SAFE_INTEGER);
  const amount = integer(req.body?.amountCents,1,orderCents);
  const reference = input(req.body?.orderReference);
  if (!reference || reference !== req.body?.orderReference) throw new SatError(400,"Referência inválida");
  const { rows: [rule] } = await satDb().query(`SELECT enabled,redemption_limit_cents,redemption_basis_points FROM sat_rules
    WHERE company=$1 AND branch IN (0,$2) ORDER BY branch DESC LIMIT 1`, [scope.company,branch]);
  if (!rule?.enabled || !rule.redemption_basis_points || !rule.redemption_limit_cents ||
    BigInt(amount) > BigInt(rule.redemption_limit_cents) ||
    BigInt(amount)*10000n > BigInt(orderCents)*BigInt(rule.redemption_basis_points)) {
    throw new SatError(409,"Resgate fora dos limites configurados");
  }
  const wallet = await balances({ ...scope, branches: [branch] },[customer]);
  if (BigInt(wallet.get(customer)?.available ?? 0) < BigInt(amount)) throw new SatError(409,"Saldo insuficiente");
  const { rows: [entry] } = await satDb().query(`INSERT INTO sat_redemption_demo
    (company,branch,customer,order_reference,order_cents,amount_cents,actor) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(company,branch,order_reference) DO NOTHING RETURNING id`,
    [scope.company,branch,customer,reference,orderCents,amount,scope.actor]);
  if (!entry) throw new SatError(409,"Simulação já registrada para esse pedido");
  res.status(201).json({ id: entry.id, status: "demonstrativo", reserved: false, confirmed: false });
});

router.post("/redemptions/:id/confirm", (req, _res) => {
  access(req,"pdv");
  throw new SatError(409,"Confirmação desativada até integração com o fechamento da venda no PDV");
});

const handleError: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof SatError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error("Falha SAT", req.method, req.route?.path ?? "", error?.code ?? error?.gdscode ?? "sem código");
  res.status(503).json({ error: "Dados do SAT indisponíveis" });
};
router.use(handleError);
export default router;
