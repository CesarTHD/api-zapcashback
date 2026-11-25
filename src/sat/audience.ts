import { access, day, integer, SatError } from "./access";
import { branchFilter, clientPhone, readErp, validSale, saleAmount } from "./erp";
import { satDb } from "./store";
import { walletCustomers, walletFilters } from "./cashback";

type Scope = ReturnType<typeof access>;
type Candidate = { CODCLI: number; DAYS: number | null; PURCHASES: number; SPENT: string; CITY: string | null; PHONE: string };
type Filters = Record<string, unknown>;

export function normalizeBrazilianPhone(phone: string) {
  const digits = phone.replace(/\D/g,"");
  if (/^[1-9][1-9][2-9]\d{7,8}$/.test(digits)) return "55" + digits;
  return /^55[1-9][1-9][2-9]\d{7,8}$/.test(digits) ? digits : null;
}

export async function selectAudience(scope: Scope, filters: Filters) {
  const { city, minDays, maxDays, minPurchases, minSpentCents, minTicketCents, lastPurchaseFrom, lastPurchaseTo,
    wallet, expiresWithinDays, customer, productCodes } = filters;
  const customerId = customer == null ? null : integer(customer,0,2147483647);
  const products = parseProductCodes(productCodes);
  const walletFilter = wallet === undefined ? null : walletFilters.find(name => name === wallet);
  if (walletFilter === undefined) throw new SatError(400,"Filtro de cashback inválido");
  if (city !== undefined && (typeof city !== "string" || city.length > 100)) throw new SatError(400,"Cidade inválida");
  const min = minDays == null ? null : integer(minDays,0,36500);
  const max = maxDays == null ? null : integer(maxDays,0,36500);
  if (min !== null && max !== null && min>max) throw new SatError(400,"Intervalo de inatividade inválido");
  const from = lastPurchaseFrom == null ? null : day(lastPurchaseFrom);
  const to = lastPurchaseTo == null ? null : day(lastPurchaseTo);
  if (from && to && from>to) throw new SatError(400,"Intervalo de última compra inválido");
  const purchases = minPurchases == null ? 0 : integer(minPurchases,0,10000000);
  const spent = minSpentCents == null ? 0n : BigInt(integer(minSpentCents,0,Number.MAX_SAFE_INTEGER));
  const ticket = minTicketCents == null ? 0n : BigInt(integer(minTicketCents,0,Number.MAX_SAFE_INTEGER));
  const expiry = wallet === "expiring" ? integer(expiresWithinDays,1,365) : null;

  const { rows } = await satDb().query(`SELECT s.customer,s.phone FROM sat_consent s WHERE s.company=$1 AND s.promotional AND NOT s.opted_out
    AND s.phone IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM sat_consent opposition WHERE opposition.company=s.company AND opposition.phone=s.phone AND opposition.opted_out)
    AND ($2::integer IS NULL OR s.customer=$2)
    ORDER BY customer LIMIT 10001`, [scope.company,customerId]);
  if (rows.length > 10000) throw new SatError(409,"Público autorizado acima do limite de auditoria desta prévia");
  const customers: number[] = [];
  const destinations = new Set<string>();
  for (let offset=0; offset<rows.length; offset+=200) {
    const matchingPhones = new Map(rows.slice(offset,offset+200).map(row => [row.customer,row.phone]));
    let ids = Array.from(matchingPhones.keys());
    if (walletFilter) {
      const withWallet = await walletCustomers(scope,ids,walletFilter,expiry);
      ids = ids.filter(id => withWallet.has(id));
      if (!ids.length) continue;
    }
    if (products.length) {
      const buyers = await productBuyers(scope,ids,products);
      ids = ids.filter(id => buyers.has(id));
      if (!ids.length) continue;
    }
    const result = await readErp<(Candidate & { LAST_PURCHASE: string | null })>(`SELECT c.CODCLI,TRIM(c.CIDR) CITY,${clientPhone} PHONE,
      DATEDIFF(DAY FROM CAST(MAX(o.DATA) AS DATE) TO CURRENT_DATE) DAYS,
      CAST(CAST(MAX(o.DATA) AS DATE) AS VARCHAR(10)) LAST_PURCHASE,
      COUNT(o.ID_OE) PURCHASES, CAST(COALESCE(SUM(${saleAmount}),0)*100 AS DECIMAL(17,0)) SPENT
      FROM CLI c LEFT JOIN OE o ON o.CODCLI=c.CODCLI AND ${validSale}${branchFilter(scope.branches)}
      WHERE c.CODCLI IN (${ids.map(() => "?").join(",")})
      AND ${clientPhone} IS NOT NULL
      GROUP BY c.CODCLI,c.CIDR,c.TELR,c.TEL1,c.TEL2 ORDER BY c.CODCLI`, [...(scope.branches || []),...ids],true);
    for (const row of result) {
      const number = normalizeBrazilianPhone(row.PHONE);
      if (!number || matchingPhones.get(row.CODCLI) !== number || destinations.has(number)) continue;
      const total = BigInt(row.SPENT);
      const volume = Number(row.PURCHASES);
      const match = (!scope.branches || volume > 0) && volume >= purchases && total >= spent &&
        (ticket === 0n || (volume > 0 && total >= ticket * BigInt(volume))) &&
        (!city || row.CITY?.toLocaleUpperCase("pt-BR").includes(city.toLocaleUpperCase("pt-BR"))) &&
        (min === null || (row.DAYS !== null && row.DAYS >= min)) &&
        (max === null || (row.DAYS !== null && row.DAYS <= max)) &&
        (!from || (row.LAST_PURCHASE && row.LAST_PURCHASE >= from)) &&
        (!to || (row.LAST_PURCHASE && row.LAST_PURCHASE <= to));
      if (match) {
        destinations.add(number);
        customers.push(row.CODCLI);
      }
    }
  }
  return customers;
}

/* Códigos de produto (PROD.COD / IOE.COD) separados por vírgula, espaço ou ponto e vírgula; até 20. */
function parseProductCodes(value: unknown) {
  if (value == null || value === "") return [];
  const parts = (Array.isArray(value) ? value : String(value).split(/[\s,;]+/)).filter(part => part !== "");
  if (parts.length > 20) throw new SatError(400,"Informe até 20 códigos de produto");
  return [...new Set(parts.map(part => integer(part,0,2147483647)))];
}

async function productBuyers(scope: Scope, customers: number[], products: number[]) {
  const rows = await readErp<{ CODCLI: number }>(`SELECT DISTINCT o.CODCLI FROM OE o
    JOIN IOE i ON i.DATA=o.DATA AND i.ID_OE=o.ID_OE
    WHERE o.CODCLI IN (${customers.map(() => "?").join(",")}) AND ${validSale}${branchFilter(scope.branches)}
    AND i.COD IN (${products.map(() => "?").join(",")}) AND NULLIF(TRIM(i.CANC),'') IS NULL`,
    [...customers,...(scope.branches || []),...products]);
  return new Set(rows.map(row => row.CODCLI));
}
