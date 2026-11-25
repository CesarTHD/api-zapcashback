-- Auditoria das gravações feitas pela API no ERP SAT (o ERP não registra o usuário da aplicação).
CREATE TABLE IF NOT EXISTS sat_erp_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL,
  actor uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('credit','redemption')),
  customer integer NOT NULL,
  branch integer,
  sale_date date,
  sale_id integer,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  -- Códigos (CLIENTES_CASHBACK.COD) criados ou consumidos e o valor em centavos de cada um.
  credits jsonb NOT NULL,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sat_erp_operations_company_created ON sat_erp_operations (company, created_at DESC);
CREATE INDEX IF NOT EXISTS sat_erp_operations_customer ON sat_erp_operations (company, customer);
