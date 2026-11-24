const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateCredit } = require("../dist/sat/cashback");
const { access, day } = require("../dist/sat/access");
const { clientList, clientSales, readErp } = require("../dist/sat/erp");

test("cashback uses half-up rounding and applies the configured cap", () => {
  assert.equal(calculateCredit(105n, 1000, 100n), 11n);
  assert.equal(calculateCredit(104n, 1000, 100n), 10n);
  assert.equal(calculateCredit(9999999999999999n, 2000, 100n), 100n);
  assert.equal(calculateCredit(100n, 0, 100n), 0n);
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
