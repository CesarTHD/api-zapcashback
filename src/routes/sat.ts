import { Router, ErrorRequestHandler, Request } from "express";
import ExcelJS from "exceljs";
import auth from "../middleware/authMiddleware";
import { access, day, integer, SatError } from "../sat/access";
import { branchFilter, clientFields, clientList, clientPhone, clientSales, clientScope, readErp, saleAmount, validSale } from "../sat/erp";
import { balances, cashbackRules, cbExpired, cbFrom, cbListFields, cbListFrom, cbOpen, cbStatusFilters, cbSummary, entryRow, expiringCredits,
  summaryRow } from "../sat/cashback";
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

const exportFields: [string, string][] = [["CODCLI","Código"],["NOME","Nome"],["CPF","Documento"],["CIDADE","Cidade"],
  ["TELEFONE","Telefone"],["NASCIMENTO","Nascimento"],["COMPRAS","Compras"],["TOTAL_GASTO","Total gasto"],
  ["ULTIMA_COMPRA","Última compra"],["DIAS_SEM_COMPRAR","Dias sem comprar"]];

async function exportRows(req: Request) {
  const scope = access(req);
  const rows = await clientList(scope.branches, input(req.query.q), input(req.query.city), 5001, 0, input(req.query.sort));
  if (rows.length > 5000) throw new SatError(400,"Refine os filtros para exportar até 5.000 clientes");
  return rows as Record<string, unknown>[];
}

router.get("/clients/export.csv", async (req, res) => {
  const rows = await exportRows(req);
  const escape = (value: unknown) => {
    const string = String(value ?? "");
    return '"' + (/^[\s]*[=+\-@]/.test(string) || /^[\r\n\t]/.test(string) ? "'" : "") + string.replace(/"/g,'""') + '"';
  };
  res.attachment("clientes-sat.csv").type("text/csv").send("\uFEFF" + [exportFields.map(([f]) => f).join(";"), ...rows.map(row =>
    exportFields.map(([f]) => escape(row[f])).join(";"))].join("\r\n"));
});

router.get("/clients/export.xlsx", async (req, res) => {
  const rows = await exportRows(req);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Clientes");
  sheet.columns = exportFields.map(([key,header]) => ({ key, header, width: key === "NOME" ? 36 : 16 }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  // Células recebem valores tipados; texto nunca é interpretado como fórmula pelo exceljs.
  for (const row of rows) sheet.addRow(Object.fromEntries(exportFields.map(([key]) => {
    const value = row[key];
    if (["COMPRAS","TOTAL_GASTO","DIAS_SEM_COMPRAR"].includes(key)) return [key, value == null ? null : Number(value)];
    return [key, value == null ? null : String(value)];
  })));
  sheet.getColumn("TOTAL_GASTO").numFmt = '"R$" #,##0.00';
  res.attachment("clientes-sat.xlsx").type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(Buffer.from(await book.xlsx.writeBuffer()));
});

router.get("/clients/summary", async (req, res) => {
  const scope = access(req);
  const branches = scope.branches;
  const [[clients], [active], [wallet]] = await Promise.all([
    readErp<Record<string, number>>(`SELECT COUNT(*) TOTAL,
      COUNT(CASE WHEN c.NAS>DATE '1900-01-01' AND EXTRACT(MONTH FROM c.NAS)=EXTRACT(MONTH FROM CURRENT_DATE) THEN 1 END) ANIVERSARIANTES
      FROM CLI c WHERE 1=1${clientScope(branches)}`, branches || []),
    readErp<Record<string, number>>(`SELECT COUNT(DISTINCT o.CODCLI) ATIVOS FROM OE o
      WHERE o.DATA>=DATEADD(-90 DAY TO CURRENT_DATE) AND ${validSale}${branchFilter(branches)}`, branches || []),
    readErp<Record<string, number>>(`SELECT COUNT(DISTINCT cb.CODCLI) COM_SALDO ${cbFrom}
      WHERE ${cbOpen} AND NOT ${cbExpired}${branchFilter(branches)}`, branches || []),
  ]);
  const consent = process.env.SAT_DATABASE_URL ? (await satDb().query<{ total: string }>(
    "SELECT count(*) total FROM sat_consent WHERE company=$1 AND promotional AND NOT opted_out AND phone IS NOT NULL",
    [scope.company])).rows[0].total : null;
  res.json({ total: clients.TOTAL, birthdays: clients.ANIVERSARIANTES, active90: active.ATIVOS,
    withCashback: wallet.COM_SALDO, whatsapp: consent === null ? null : Number(consent) });
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
  const rows = await readErp(`SELECT FIRST 101 SKIP ? i.ID_ITEM,i.COD,
    COALESCE(NULLIF(TRIM(i.NOME),''),(SELECT FIRST 1 TRIM(p.PRODUTO) FROM PROD p WHERE p.COD=i.COD)) NOME,
    i.QUANT,CAST(COALESCE(i.VCON,i.VALOR) AS DECIMAL(15,2)) UNITARIO,CAST(COALESCE(i.VALORDESCONTO,0) AS DECIMAL(15,2)) DESCONTO,
    CAST(i.VALORTOTAL AS DECIMAL(15,2)) TOTAL,NULLIF(TRIM(i.CANC),'') CANC,i.QUANT_DEVOLVIDO
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
    expiringCredits(scope,id),
    satDb().query(`SELECT q.id,q.status,q.attempted_at,q.provider_status,c.name FROM sat_message_queue q
      JOIN sat_campaigns c ON c.id=q.campaign WHERE c.company=$1 AND q.customer=$2
      AND ($3::integer[] IS NULL OR c.branches<@$3) ORDER BY q.id DESC LIMIT 20`, [scope.company,id,scope.branches]),
  ]);
  res.json({ balance: map.get(id) ?? summaryRow(),
    consent: consent.rows[0] ?? null, credits, messages: messages.rows });
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
  const branches = branch ? [branch] : scope.branches;
  const rows = await readErp<Record<string, string>>(`SELECT CAST(CAST(cb.DATA_OE AS DATE) AS VARCHAR(10)) DIA, ${cbSummary}
    ${cbFrom} WHERE cb.DATA_OE>=CAST(? AS DATE) AND cb.DATA_OE<DATEADD(1 DAY TO CAST(? AS DATE))${branchFilter(branches)}
    GROUP BY 1 ORDER BY 1`, [start,end,...(branches || [])], true);
  res.json({ rows: rows.map(row => ({ day: row.DIA, ...summaryRow(row) })) });
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
  if (status !== null && !(status in cbStatusFilters)) throw new SatError(400,"Status inválido");
  const branches = branch ? [branch] : scope.branches;
  const where: string[] = ["1=1"];
  const params: (string | number)[] = [offset];
  if (customer !== null) { where.push("cb.CODCLI=?"); params.push(customer); }
  const search = input(req.query.q);
  if (search) {
    where.push("(c.CLI CONTAINING ? OR c.CPF CONTAINING ? OR c.TELR CONTAINING ? OR c.TEL1 CONTAINING ? OR c.TEL2 CONTAINING ?)");
    params.push(search,search,search,search,search);
  }
  if (start) { where.push("cb.DATA_OE>=CAST(? AS DATE)"); params.push(start); }
  if (end) { where.push("cb.DATA_OE<DATEADD(1 DAY TO CAST(? AS DATE))"); params.push(end); }
  if (status) where.push(cbStatusFilters[status]);
  const rows = await readErp<Parameters<typeof entryRow>[0]>(`SELECT FIRST 51 SKIP ? ${cbListFields()} ${cbListFrom}
    WHERE ${where.join(" AND ")}${branchFilter(branches)} ORDER BY cb.COD DESC`, [...params,...(branches || [])], true);
  res.json({ rows: rows.slice(0,50).map(entryRow), more: rows.length>50 });
});

router.get("/rules", async (req, res) => {
  res.json({ rows: await cashbackRules(access(req,"admin")) });
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
