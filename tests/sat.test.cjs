const test = require("node:test");
const assert = require("node:assert/strict");
const { balances, cashbackRules, entryRow, cbEntryFields, cbFrom } = require("../dist/sat/cashback");
const { access, day } = require("../dist/sat/access");
const { clientList, clientSales, readErp } = require("../dist/sat/erp");

test("maps ERP cashback status and keeps amounts in cents", () => {
  const base = { COD: 1, LOJA: 1, CODCLI: 2, SALE_DATE: "2026-01-01", ID_OE: 3, SALE_CENTS: "1000", AMOUNT_CENTS: "50",
    REDEEMED_CENTS: "0", REMAINING_CENTS: "50", EXPIRES_AT: "2026-02-01", EXPIRED: 0 };
  assert.equal(entryRow({ ...base, STATUS: 0 }).status, "disponível");
  assert.equal(entryRow({ ...base, STATUS: 0, EXPIRED: 1 }).status, "expirado");
  assert.equal(entryRow({ ...base, STATUS: 1 }).status, "resgatado");
  assert.equal(entryRow({ ...base, STATUS: 2 }).status, "cancelado");
  assert.equal(entryRow({ ...base, STATUS: 7 }).status, "indefinido");
  assert.equal(entryRow({ ...base, STATUS: 0 }).amount_cents, "50");
});

test("rejects calendar rollover", () => {
  assert.equal(day("2024-02-29"), "2024-02-29");
  assert.throws(() => day("2025-02-29"), { status: 400 });
});

test("denies missing claims, another company and unauthorized roles", () => {
  const previous = process.env.SAT_COMPANY_ID;
  process.env.SAT_COMPANY_ID = "test-company";
  try {
    const user = { id: "test", app_metadata: { sat: { company: "test-company", branches: [1], role: "operator" } } };
    assert.deepEqual(access({ user }, "operator").branches, [1]);
    assert.throws(() => access({ user }, "admin"), { status: 403 });
    assert.throws(() => access({ user: { ...user, app_metadata: {} } }), { status: 403 });
    assert.throws(() => access({ user: { ...user, app_metadata: { sat: { company: "different", branches: null } } } }), { status: 403 });
  } finally {
    if (previous === undefined) delete process.env.SAT_COMPANY_ID;
    else process.env.SAT_COMPANY_ID = previous;
  }
});

test("reads real ERP clients and orders without logging customer data", { skip: !process.env.SAT_DB_DATABASE }, async () => {
  const rows = await clientList(null, "", "", 3, 0, "spent");
  assert.ok(rows.length > 0 && rows.length <= 3);
  const scoped = await clientList([1], "", "", 3, 0, "recent");
  assert.ok(scoped.length > 0 && scoped.length <= 3);
  const sales = await clientSales([1], scoped[0].CODCLI, 0);
  assert.ok(sales.length > 0);
  assert.ok(sales.every(sale => sale.LOJA === 1));
  const [transaction] = await readErp("SELECT MON$READ_ONLY READ_ONLY FROM MON$TRANSACTIONS WHERE MON$TRANSACTION_ID=CURRENT_TRANSACTION");
  assert.equal(transaction.READ_ONLY, 1);
});

test("reads ERP cashback balances consistent with CLIENTES_CASHBACK", { skip: !process.env.SAT_DB_DATABASE }, async () => {
  const rows = await readErp(`SELECT FIRST 20 ${cbEntryFields} ${cbFrom} ORDER BY cb.COD DESC`, [], true);
  const customers = [...new Set(rows.map(row => row.CODCLI))];
  const wallets = await balances({ branches: null }, customers);
  for (const customer of customers) {
    const wallet = wallets.get(customer);
    assert.ok(wallet, "cliente com cashback precisa ter saldo calculado");
    assert.ok(BigInt(wallet.available) + BigInt(wallet.expired) + BigInt(wallet.redeemed) <= BigInt(wallet.generated));
  }
  assert.ok(Array.isArray(await cashbackRules({ branches: null })));
});
