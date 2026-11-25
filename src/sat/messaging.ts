import axios from "axios";
import { access, SatError } from "./access";
import { normalizeBrazilianPhone, selectAudience } from "./audience";
import { clientPhone, clientScope, readErp } from "./erp";
import { balances } from "./cashback";
import { satDb, transaction } from "./store";
import { sendEvolution } from "../services/evolution";

type Scope = ReturnType<typeof access>;

export async function queueCampaign(scope: Scope, body: Record<string, unknown>) {
  const { id, name, template, scheduleAt, filters } = body;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    typeof name !== "string" || !name.trim() || name.length>100 ||
    typeof template !== "string" || !template.trim() || template.length>2000 ||
    typeof scheduleAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(scheduleAt) ||
    !Number.isFinite(Date.parse(scheduleAt)) || Date.parse(scheduleAt)>Date.now()+366*86400000 ||
    !filters || Array.isArray(filters) || typeof filters !== "object") throw new SatError(400,"Campanha inválida");
  const customers = await selectAudience(scope, filters as Record<string, unknown>);
  if (!customers.length || customers.length>1000) throw new SatError(409,"A campanha exige entre 1 e 1.000 destinatários autorizados");
  return transaction(async db => {
    const { rows: [campaign] } = await db.query(`INSERT INTO sat_campaigns (id,company,actor,branches,name,template,kind,schedule_at)
      VALUES ($1,$2,$3,$4,$5,$6,'promotional',$7) ON CONFLICT DO NOTHING RETURNING id`,
      [id,scope.company,scope.actor,scope.branches,name.trim(),template.trim(),scheduleAt]);
    if (!campaign) throw new SatError(409,"Identificador de campanha já registrado");
    await db.query(`INSERT INTO sat_message_queue (campaign,customer,next_at)
      SELECT $1,customer,$3 FROM unnest($2::integer[]) AS recipients(customer)`, [id,customers,scheduleAt]);
    return { id, recipients: customers.length };
  });
}

function configuration() {
  const company = process.env.SAT_COMPANY_ID;
  const url = process.env.EVOLUTION_URL;
  const instance = process.env.EVOLUTION_INSTANCE;
  const key = process.env.EVOLUTION_API_KEY;
  if (!company || !url || !instance || !key) return null;
  const interval = Number(process.env.SAT_MESSAGE_INTERVAL_SECONDS || 20);
  if (!Number.isSafeInteger(interval) || interval<5 || interval>3600) return null;
  return { company, url, instance, key, interval };
}

export async function dispatch(config: NonNullable<ReturnType<typeof configuration>>) {
  const db = await satDb().connect();
  let locked = false;
  try {
    const { rows: [lock] } = await db.query("SELECT pg_try_advisory_lock(hashtext($1),721825) held", [config.company]);
    if (!lock.held) return;
    locked = true;
    await db.query(`UPDATE sat_message_queue q SET status='unknown' FROM sat_campaigns c
      WHERE q.campaign=c.id AND c.company=$1 AND q.status='sending' AND attempted_at<now()-interval '5 minutes'`, [config.company]);
    const { rows: [message] } = await db.query(`SELECT q.id,q.customer,q.attempts,c.template,c.actor,c.branches,c.kind,
      q.automation_event,q.ledger_id
      FROM sat_message_queue q JOIN sat_campaigns c ON c.id=q.campaign WHERE c.company=$1 AND q.status='queued' AND q.next_at<=now()
      AND NOT EXISTS (SELECT 1 FROM sat_message_queue recent JOIN sat_campaigns other ON other.id=recent.campaign
        WHERE other.company=$1 AND recent.attempted_at>now()-$2::integer*interval '1 second')
      ORDER BY q.next_at,q.id LIMIT 1`, [config.company,config.interval]);
    if (!message) return;
    const [customer] = await readErp<{ NAME: string | null; PHONE: string | null }>(`SELECT TRIM(c.CLI) NAME,${clientPhone} PHONE
      FROM CLI c WHERE c.CODCLI=? ${clientScope(message.branches)}`, [message.customer,...(message.branches || [])]);
    const number = customer?.PHONE ? normalizeBrazilianPhone(customer.PHONE) : null;
    const scope = { company: config.company, branches: message.branches, actor: message.actor };
    const wallet = await balances(scope,[message.customer]);
    const available = Number(wallet.get(message.customer)?.available || 0);
    if (["granted","released","expiring"].includes(message.automation_event) && available <= 0) {
      await db.query("UPDATE sat_message_queue SET status='skipped' WHERE id=$1 AND status='queued'", [message.id]);
      return;
    }
    const formatted = new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(available/100);
    const text = message.template.replace(/\{\{(nome|saldo_cashback)\}\}/g, (_: string, field: string) =>
      field === "nome" ? customer?.NAME || "cliente" : formatted);
    const { rowCount } = await db.query(`UPDATE sat_message_queue q SET status='sending',attempted_at=now(),attempts=attempts+1
      WHERE id=$1 AND status='queued' AND EXISTS (SELECT 1 FROM sat_consent s
        WHERE s.company=$2 AND s.customer=q.customer AND s.phone=$3 AND NOT s.opted_out
        AND CASE WHEN $4='transactional' THEN s.transactional ELSE s.promotional END
        AND NOT EXISTS (SELECT 1 FROM sat_consent blocked WHERE blocked.company=s.company AND blocked.phone=s.phone AND blocked.opted_out))
      AND (q.automation_event IS NULL OR EXISTS (
        SELECT 1 FROM sat_automations automation WHERE automation.company=$2 AND automation.event=q.automation_event AND automation.enabled))
      AND (q.ledger_id IS NULL OR EXISTS (SELECT 1 FROM sat_ledger l WHERE l.id=q.ledger_id AND l.company=$2
        AND (q.automation_event='expired' OR l.expires_at>now())
        AND NOT EXISTS (SELECT 1 FROM sat_ledger r WHERE r.company=l.company AND r.sale_date=l.sale_date
          AND r.sale_id=l.sale_id AND r.kind='reversal')))`,
      [message.id,config.company,number,message.kind]);
    if (!rowCount) {
      await db.query("UPDATE sat_message_queue SET status='skipped' WHERE id=$1 AND status='queued'", [message.id]);
      return;
    }
    let status = "unknown";
    let providerId: string | null = null;
    let providerStatus: string | null = null;
    try {
      const response = await sendEvolution(config.url,config.instance,config.key,"sendText",{ number, text });
      status = "accepted";
      providerId = safeProviderField(response.data?.key?.id);
      providerStatus = safeProviderField(response.data?.status);
    } catch (error) {
      const code = axios.isAxiosError(error) ? error.response?.status : undefined;
      providerStatus = code ? String(code) : null;
      if (code === 429 && message.attempts < 2) status = "queued";
      else if (code && code >= 400 && code < 500 && code !== 408) status = "failed";
    }
    await db.query(`UPDATE sat_message_queue SET status=$2,provider_id=$3,provider_status=$4,
      next_at=CASE WHEN $2='queued' THEN now()+interval '5 minutes' ELSE next_at END WHERE id=$1`,
      [message.id,status,providerId,providerStatus]);
  } finally {
    if (locked) {
      try {
        await db.query("SELECT pg_advisory_unlock(hashtext($1),721825)",[config.company]);
      } catch {
        db.release(true);
        return;
      }
    }
    db.release();
  }
}

function safeProviderField(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}

export function startSatMessaging() {
  if (process.env.SAT_MESSAGE_WORKER !== "true") return;
  const config = configuration();
  if (!config) {
    console.error("Configuração do processador de mensagens SAT incompleta");
    return;
  }
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void dispatch(config).catch(error => console.error("Falha no processador de mensagens SAT",error?.code ?? "sem código"))
      .finally(() => { running = false; });
  },5000).unref();
}
