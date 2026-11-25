const assert = require("node:assert/strict");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const express = require("express");
const { readErp } = require("../dist/sat/erp");

async function run() {
  assert.ok(process.env.SAT_TEST_DATABASE_URL, "Informe um banco PostgreSQL descartável");
  process.env.SAT_DATABASE_URL = process.env.SAT_TEST_DATABASE_URL;
  process.env.SAT_COMPANY_ID = "sat-integration-test";
  process.env.SAT_ERP_WRITE = "false"; // o teste nunca grava no ERP
  const { satDb } = require("../dist/sat/store");
  const { clientPhone } = require("../dist/sat/erp");
  const { normalizeBrazilianPhone } = require("../dist/sat/audience");
  const { dispatch } = require("../dist/sat/messaging");
  const { enqueueAutomations } = require("../dist/sat/automations");
  const db = satDb();
  const app = express();
  const auth = require.resolve("../dist/middleware/authMiddleware");
  require.cache[auth] = { exports: { default(req, _res, next) {
    req.user = { id: "5e86c313-22a5-4b56-891a-21e86eb5d6cc", app_metadata: { sat: {
      company: process.env.SAT_COMPANY_ID, branches: req.get("x-test-branch") ? [32767] : null, role: req.get("x-test-role") || "admin",
    } } };
    next();
  }, __esModule: true } };
  app.use(express.json(), require("../dist/routes/sat").default);
  const server = app.listen(0,"127.0.0.1");
  try {
    await once(server,"listening");
    const migrations = require("node:path").dirname(require.resolve("../migrations/001_sat.sql"));
    for (const file of require("node:fs").readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
      await db.query(readFileSync(require("node:path").join(migrations,file),"utf8"));
    }
    const call = async (url, status, body, method = body ? "POST" : "GET", headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`,{
        method, headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body),
      });
      assert.equal(response.status,status,url);
      return status === 204 || !(response.headers.get("content-type") || "").includes("json") ? null : response.json();
    };
    const [sale] = await readErp(`SELECT FIRST 1 CAST(CAST(o.DATA AS DATE) AS VARCHAR(10)) DIA,o.ID_OE,o.LOJA,o.CODCLI
      FROM OE o JOIN CLI c ON c.CODCLI=o.CODCLI WHERE o.TIPO='V' AND o.LOJA>0 AND COALESCE(TRIM(o.CANC),'')=''
      AND COALESCE(o.STATUS,0)=0 ORDER BY o.DATA DESC,o.ID_OE DESC`);
    assert.ok(sale,"Venda válida necessária na cópia de teste do ERP");
    await call("/rules",200);
    await call("/clients",200);
    await call(`/clients/${sale.CODCLI}`,200);
    await call(`/clients/${sale.CODCLI}`,404,undefined,"GET",{ "x-test-branch": "1" });
    await call(`/dashboard?start=${sale.DIA}&end=${sale.DIA}`,200);
    const [credit] = await readErp(`SELECT FIRST 1 cb.CODCLI,CAST(CAST(cb.DATA_OE AS DATE) AS VARCHAR(10)) DIA
      FROM CLIENTES_CASHBACK cb ORDER BY cb.COD DESC`);
    if (credit) {
      const wallet = await call(`/clients/${credit.CODCLI}/cashback`,200);
      const history = await call(`/cashback?customer=${credit.CODCLI}`,200);
      assert.ok(history.rows.length > 0);
      const remaining = history.rows.filter(row => row.status === "disponível").reduce((sum,row) => sum+BigInt(row.remaining_cents),0n);
      if (!history.more) assert.equal(wallet.balance.available,remaining.toString());
      const analytics = await call(`/dashboard/cashback?start=${credit.DIA}&end=${credit.DIA}`,200);
      assert.equal(analytics.rows.length,1);
    }
    await call("/cashback?status=pendente",400);
    assert.equal((await call("/access",200)).erpWrite,false);
    await call("/cashback",409,{ date:sale.DIA,saleId:sale.ID_OE,creditCents:"1" });
    await call("/cashback/redemptions",409,{ customer:sale.CODCLI,amountCents:1 });
    await call("/cashback/redemptions",400,{ customer:sale.CODCLI,amountCents:0 });
    assert.ok(Array.isArray((await call("/cashback/operations",200)).rows));
    const summary = await call("/clients/summary",200);
    assert.ok(summary.total >= summary.withCashback);
    const xlsx = await fetch(`http://127.0.0.1:${server.address().port}/clients/export.xlsx`);
    assert.equal(xlsx.status,200);
    assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0,2).toString(),"PK");
    const dashboard = await call(`/dashboard?start=${sale.DIA}&end=${sale.DIA}`,200);
    assert.ok("CASHBACK_GERADO" in dashboard.totals && "FATURAMENTO_COM_RESGATE" in dashboard.totals);
    for (const removed of ["/cashback/process","/redemptions/authorize"]) await call(removed,404,{});

    const people = await readErp(`SELECT FIRST 300 c.CODCLI,${clientPhone} PHONE FROM CLI c WHERE ${clientPhone} IS NOT NULL ORDER BY c.CODCLI`);
    const person = people.find(candidate => normalizeBrazilianPhone(candidate.PHONE));
    assert.ok(person, "A cópia do ERP precisa conter um telefone válido para o teste local");
    const consent = { promotional:true,transactional:true,optedOut:false,evidence:"teste-local-isolado" };
    await call(`/clients/${person.CODCLI}/consent`,204,consent,"PUT");
    for (const event of ["granted","released","expiring","expired","inactive","birthday"]) {
      await call(`/automations/${event}`,204,{ enabled:true,days:7,template:"Olá {{nome}}" },"PUT");
    }
    assert.equal((await call("/automations",200)).rows.length,6);
    await enqueueAutomations(process.env.SAT_COMPANY_ID);
    await enqueueAutomations(process.env.SAT_COMPANY_ID);
    const duplicated = await db.query("SELECT event,event_key FROM sat_automation_events GROUP BY 1,2 HAVING count(*)>1");
    assert.equal(duplicated.rows.length,0);
    await db.query("UPDATE sat_automations SET enabled=false");
    await db.query("UPDATE sat_message_queue SET status='skipped' WHERE status='queued'");
    assert.equal((await call("/audiences/preview",200,{})).count,1);
    const [bought] = await readErp(`SELECT FIRST 1 i.COD FROM OE o JOIN IOE i ON i.DATA=o.DATA AND i.ID_OE=o.ID_OE
      WHERE o.CODCLI=? AND o.TIPO='V' AND COALESCE(TRIM(o.CANC),'')='' AND COALESCE(o.STATUS,0)=0 AND NULLIF(TRIM(i.CANC),'') IS NULL`,[person.CODCLI]);
    if (bought) assert.equal((await call("/audiences/preview",200,{ productCodes:String(bought.COD) })).count,1);
    assert.equal((await call("/audiences/preview",200,{ productCodes:"2147483647" })).count,0);
    await call("/audiences/preview",400,{ productCodes:"x" });
    const campaign = { id:crypto.randomUUID(), name:"Integração local", template:"Olá {{nome}}. Seu saldo é {{saldo_cashback}}.",
      scheduleAt:new Date().toISOString(), filters:{} };
    assert.equal((await call("/campaigns",201,campaign)).recipients,1);
    await call("/campaigns",409,campaign);
    await call("/campaigns",200);
    let requests = 0;
    const providerApp = express();
    providerApp.use(express.json());
    providerApp.post("/message/sendText/test", (req,res) => {
      requests++;
      assert.equal(req.body.number,normalizeBrazilianPhone(person.PHONE));
      assert.equal(req.body.text.includes("{{"),false);
      res.status(201).json({ key:{ id:"test-message" },status:"PENDING" });
    });
    const provider = providerApp.listen(0,"127.0.0.1");
    try {
      await once(provider,"listening");
      const config = { company:process.env.SAT_COMPANY_ID,url:`http://127.0.0.1:${provider.address().port}`,instance:"test",key:"test",interval:0 };
      await dispatch(config);
      const log = await call(`/campaigns/${campaign.id}/messages`,200);
      assert.equal(log.rows[0].status,"accepted");
      assert.equal(log.rows[0].provider_status,"PENDING");
      const second = { ...campaign,id:crypto.randomUUID() };
      await call("/campaigns",201,second);
      await call(`/clients/${person.CODCLI}/consent`,204,{ ...consent,promotional:false,transactional:false,optedOut:true },"PUT");
      await dispatch(config);
      assert.equal((await call(`/campaigns/${second.id}/messages`,200)).rows[0].status,"skipped");
      assert.equal(requests,1);
    } finally {
      await new Promise(resolve => provider.close(resolve));
    }
    console.log("Integração SAT: clientes, dashboard, cashback do ERP, regras das lojas, consentimento, automações e fila verificados.");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
