import { randomUUID } from "node:crypto";
import { readErp, validSale } from "./erp";
import { satDb, transaction } from "./store";
import { CreditEvent, creditEventCandidates } from "./cashback";

export const automationEvents = ["granted","released","expiring","expired","inactive","birthday"] as const;
type Event = typeof automationEvents[number];
type Rule = { event: Event; days: number; actor: string; template: string; active_since: Date };
type Candidate = { customer: number; event_key: string; ledger_id?: string };

const eventNames: Record<Event,string> = {
  granted: "Cashback gerado", released: "Cashback liberado", expiring: "Cashback próximo do vencimento",
  expired: "Cashback expirado", inactive: "Cliente inativo", birthday: "Aniversário",
};

const dayFormatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" });

/* Créditos vêm de CLIENTES_CASHBACK no ERP; a chave do evento é o código do crédito (cb:COD). */
async function creditEvents(company: string, rule: Rule) {
  const consented = await satDb().query<{ customer: number }>(`SELECT s.customer FROM sat_consent s
    WHERE s.company=$1 AND s.transactional AND NOT s.opted_out AND s.phone IS NOT NULL ORDER BY customer LIMIT 10001`, [company]);
  if (consented.rows.length>10000) return [];
  const since = dayFormatter.format(rule.active_since);
  const result: Candidate[] = [];
  for (let offset=0; offset<consented.rows.length && result.length<100; offset+=200) {
    const ids = consented.rows.slice(offset,offset+200).map(row => row.customer);
    const found = await creditEventCandidates(ids,rule.event as CreditEvent,since,rule.days);
    if (!found.length) continue;
    const done = await satDb().query<{ event_key: string }>(`SELECT event_key FROM sat_automation_events
      WHERE company=$1 AND event=$2 AND event_key=ANY($3::text[])`, [company,rule.event,found.map(row => row.event_key)]);
    const processed = new Set(done.rows.map(row => row.event_key));
    result.push(...found.filter(row => !processed.has(row.event_key)));
  }
  return result.slice(0,100);
}

async function promotionalEvents(company: string, rule: Rule) {
  const today = dayFormatter.format(new Date());
  const already = await satDb().query<{ customer: number }>(`SELECT s.customer FROM sat_consent s
    WHERE s.company=$1 AND s.promotional AND NOT s.opted_out AND s.phone IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sat_automation_events e WHERE e.company=s.company AND e.event=$2
      AND e.event_key=s.customer::text||':'||$3)
    ORDER BY customer LIMIT 10001`,[company,rule.event,today]);
  if (already.rows.length>10000) return [];
  const result: Candidate[] = [];
  for (let offset=0; offset<already.rows.length && result.length<100; offset+=200) {
    const ids = already.rows.slice(offset,offset+200).map(row => row.customer);
    const placeholders = ids.map(() => "?").join(",");
    const rows = rule.event === "birthday"
      ? await readErp<{ CODCLI: number }>(`SELECT c.CODCLI FROM CLI c WHERE c.CODCLI IN (${placeholders})
        AND c.NAS>DATE '1900-01-01' AND c.NAS<CAST(? AS DATE)
        AND EXTRACT(MONTH FROM c.NAS)=? AND EXTRACT(DAY FROM c.NAS)=?`,
        [...ids,today,Number(today.slice(5,7)),Number(today.slice(8,10))])
      : await readErp<{ CODCLI: number }>(`SELECT o.CODCLI FROM OE o WHERE o.CODCLI IN (${placeholders})
        AND ${validSale} GROUP BY o.CODCLI HAVING CAST(MAX(o.DATA) AS DATE)=DATEADD(? DAY TO CAST(? AS DATE))`,
        [...ids,-rule.days,today]);
    result.push(...rows.map(row => ({ customer:row.CODCLI,event_key:`${row.CODCLI}:${today}` })));
  }
  return result.slice(0,100);
}

export async function enqueueAutomations(company: string) {
  const { rows } = await satDb().query<Rule>("SELECT * FROM sat_automations WHERE company=$1 AND enabled ORDER BY event", [company]);
  for (const rule of rows) {
    const promotional = rule.event === "birthday" || rule.event === "inactive";
    const candidates = promotional ? await promotionalEvents(company,rule) : await creditEvents(company,rule);
    for (const candidate of candidates) {
      await transaction(async db => {
        const { rowCount } = await db.query(`INSERT INTO sat_automation_events(company,event,event_key)
          SELECT company,event,$3 FROM sat_automations WHERE company=$1 AND event=$2 AND enabled AND active_since=$4
          ON CONFLICT DO NOTHING`, [company,rule.event,candidate.event_key,rule.active_since]);
        if (!rowCount) return;
        const id = randomUUID();
        await db.query(`INSERT INTO sat_campaigns (id,company,actor,name,template,kind,schedule_at)
          VALUES ($1,$2,$3,$4,$5,$6,now())`,[id,company,rule.actor,eventNames[rule.event],rule.template,
          promotional ? "promotional" : "transactional"]);
        await db.query(`INSERT INTO sat_message_queue (campaign,customer,next_at,ledger_id,automation_event)
          VALUES ($1,$2,now(),$3,$4)`,[id,candidate.customer,candidate.ledger_id ?? null,rule.event]);
      });
    }
  }
}

export function startSatAutomations() {
  const company = process.env.SAT_COMPANY_ID;
  if (!company || process.env.SAT_MESSAGE_WORKER !== "true") return;
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void enqueueAutomations(company)
      .catch(error => console.error("Falha nas automações SAT",error?.code ?? "sem código"))
      .finally(() => { running = false; });
  },600000).unref();
}
