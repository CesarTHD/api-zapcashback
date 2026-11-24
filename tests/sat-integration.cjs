const assert = require("node:assert/strict");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const express = require("express");
const { readErp } = require("../dist/sat/erp");

async function run() {
  assert.ok(process.env.SAT_TEST_DATABASE_URL, "Informe um banco PostgreSQL descartável");
  process.env.SAT_DATABASE_URL = process.env.SAT_TEST_DATABASE_URL;
  process.env.SAT_COMPANY_ID = "sat-integration-test";
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
    await db.query(readFileSync(require.resolve("../migrations/001_sat.sql"),"utf8"));
    const call = async (url, status, body, method = body ? "POST" : "GET", headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`,{
        method, headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body),
      });
      assert.equal(response.status,status,url);
      return status === 204 ? null : response.json();
    };
    const [sale] = await readErp(`SELECT FIRST 1 CAST(CAST(o.DATA AS DATE) AS VARCHAR(10)) DIA,o.ID_OE,o.LOJA,o.CODCLI
      FROM OE o JOIN CLI c ON c.CODCLI=o.CODCLI WHERE o.TIPO='V' AND o.LOJA>0 AND COALESCE(TRIM(o.CANC),'')=''
      AND COALESCE(o.STATUS,0)=0 AND COALESCE(o.TOTALDOPEDIDO,o.TOTAL)>=1
      AND COALESCE(o.VALOR_CASHBACK_GERADO,0)=0 AND COALESCE(o.VALOR_CASHBACK_NUMMUS,0)=0 AND COALESCE(o.VALOR_CASHBACK,0)=0
      AND NOT EXISTS (SELECT 1 FROM CLIENTES_CASHBACK b WHERE b.ID_OE=o.ID_OE AND b.DATA_OE=o.DATA)
      AND NOT EXISTS (SELECT 1 FROM IOE i WHERE i.DATA=o.DATA AND i.ID_OE=o.ID_OE AND
        (COALESCE(i.QUANT_DEVOLVIDO,0)>0 OR TRIM(i.DEVOLVIDO)='S' OR NULLIF(TRIM(i.CANC),'') IS NOT NULL))
      ORDER BY o.DATA DESC,o.ID_OE DESC`);
    assert.ok(sale,"Venda elegível necessária na cópia de teste do ERP");
    await call("/rules/0",204,{ enabled:true,basisPoints:1000,minimumCents:0,maximumCents:10000,delayDays:0,validityDays:30,
      startsOn:sale.DIA,redemptionLimitCents:1000,redemptionBasisPoints:5000 },"PUT");
    await call("/clients",200);
    await call(`/clients/${sale.CODCLI}`,200);
    await call(`/clients/${sale.CODCLI}`,404,undefined,"GET",{ "x-test-branch": "1" });
    await call(`/dashboard?start=${sale.DIA}&end=${sale.DIA}`,200);
    const payload = { date:sale.DIA,saleId:sale.ID_OE };
    const preview = await call("/cashback/preview",200,payload);
    const confirmation = { ...payload,saleCents:preview.saleCents,creditCents:preview.creditCents };
    await call("/cashback",409,{ ...confirmation,creditCents:"0" });
    const entry = await call("/cashback",201,confirmation);
    assert.equal(preview.creditCents,entry.amount_cents);
    await call("/cashback",409,confirmation);
    const wallet = await call(`/clients/${sale.CODCLI}/cashback`,200);
    assert.equal(wallet.balance.available,entry.amount_cents);
    const pdv = { branch:sale.LOJA,customer:sale.CODCLI,orderCents:10000,amountCents:1,orderReference:"test-order" };
    const demo = await call("/redemptions/authorize",201,pdv,"POST",{ "x-test-role":"pdv" });
    assert.equal(demo.confirmed,false);
    await call("/redemptions/authorize",409,pdv,"POST",{ "x-test-role":"pdv" });
    await call(`/redemptions/${demo.id}/confirm`,409,{},"POST",{ "x-test-role":"pdv" });
    await call(`/cashback/${entry.id}/reversal`,201,{});
    await call(`/cashback/${entry.id}/reversal`,409,{});
    const history = await call("/cashback",200);
    assert.equal(history.rows.length,2);
    const today = new Intl.DateTimeFormat("sv-SE",{timeZone:"America/Sao_Paulo"}).format(new Date());
    const analytics = await call(`/dashboard/cashback?start=${today}&end=${today}`,200);
    assert.equal(analytics.rows[0].generated,entry.amount_cents);
    assert.equal(analytics.rows[0].available,"0");
    await assert.rejects(db.query("UPDATE sat_ledger SET amount_cents=1"), { code: "P0001" });

    const people = await readErp(`SELECT FIRST 300 c.CODCLI,${clientPhone} PHONE FROM CLI c WHERE ${clientPhone} IS NOT NULL ORDER BY c.CODCLI`);
    const person = people.find(candidate => normalizeBrazilianPhone(candidate.PHONE));
    assert.ok(person, "A cópia do ERP precisa conter um telefone válido para o teste local");
    const consent = { promotional:true,transactional:true,optedOut:false,evidence:"teste-local-isolado" };
    await call(`/clients/${person.CODCLI}/consent`,204,consent,"PUT");
    for (const event of ["granted","released","expiring","expired","inactive","birthday"]) {
      await call(`/automations/${event}`,204,{ enabled:true,days:7,template:"Olá {{nome}}" },"PUT");
    }
    assert.equal((await call("/automations",200)).rows.length,6);
    await db.query(`INSERT INTO sat_ledger (company,branch,customer,sale_date,sale_id,sale_cents,amount_cents,
      kind,source,actor,available_at,expires_at) VALUES ($1,$2,$3,CURRENT_DATE,2147483647,100,10,
      'credit','manual','5e86c313-22a5-4b56-891a-21e86eb5d6cc',now(),now()+interval '5 days')`,
      [process.env.SAT_COMPANY_ID,sale.LOJA,person.CODCLI]);
    await enqueueAutomations(process.env.SAT_COMPANY_ID);
    await enqueueAutomations(process.env.SAT_COMPANY_ID);
    const events = await db.query("SELECT event,count(*)::integer count FROM sat_automation_events GROUP BY event");
    for (const event of ["granted","released","expiring"]) assert.equal(events.rows.find(row => row.event===event)?.count,1);
    await db.query("UPDATE sat_automations SET enabled=false");
    await db.query("UPDATE sat_message_queue SET status='skipped' WHERE status='queued'");
    assert.equal((await call("/audiences/preview",200,{})).count,1);
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
    console.log("Integração SAT: clientes, dashboard, regras, ledger, resgate demonstrativo, consentimento e fila verificados.");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
