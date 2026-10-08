-- AI decisions (issue #3) and the customer's approval of AI proposals (#16).
--
-- Each analysis the assistant concludes is one ai_decisions row: a trade
-- proposal or no trade, with the model, prompt version, input snapshot and
-- rationale that produced it. Only the assistant's own route on the execution
-- worker writes them, and they are never changed.
CREATE TABLE ai_decisions (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trade_proposal', 'no_trade')),
  proposal_id uuid UNIQUE,
  -- The instrument a no-trade decision considered, if one.
  instrument text,
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 100),
  source_snapshot_id uuid NOT NULL,
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000),
  -- The assistant's tool call, so a replayed call records nothing twice.
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts(customer_id, id),
  FOREIGN KEY (customer_id, proposal_id)
    REFERENCES trade_proposals(customer_id, id),
  CHECK ((kind = 'trade_proposal') = (proposal_id IS NOT NULL)),
  CHECK (kind = 'no_trade' OR instrument IS NULL)
);

CREATE INDEX ai_decisions_customer_time_idx
  ON ai_decisions (customer_id, created_at DESC);

ALTER TABLE ai_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_isolation ON ai_decisions
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

-- Decisions are a record: added, never changed.
GRANT SELECT, INSERT ON ai_decisions TO trading_app;

-- A proposal the assistant drafts in conversation belongs to no strategy. The
-- customer approves each one, and the worker checks it under the dashboard's
-- manual limits, as it would the customer's own order. A strategy's
-- proposals still name their strategy version.
--
-- The customer approves or rejects a draft once. A draft whose entry expiry
-- passes becomes expired, and an approval that the execution checks refuse
-- becomes rejected. decided_by says who decided, and decision_reason why.
-- 'authorized' stays for proposals a strategy's checks pass without the
-- customer.
ALTER TABLE trade_proposals
  ALTER COLUMN strategy_id DROP NOT NULL,
  ALTER COLUMN strategy_version DROP NOT NULL,
  ADD CONSTRAINT trade_proposals_strategy_version_check
    CHECK ((strategy_id IS NULL) = (strategy_version IS NULL)),
  DROP CONSTRAINT trade_proposals_status_check,
  ADD CONSTRAINT trade_proposals_status_check
    CHECK (status IN ('draft', 'approved', 'rejected', 'authorized', 'expired')),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decided_by text
    CHECK (decided_by IN ('customer', 'execution_checks', 'expiry')),
  ADD COLUMN decision_reason text CHECK (char_length(decision_reason) <= 1000);

-- An approved proposal's order intent also keeps the order exactly as it is
-- sent, in manual_order, so status checks, exposure and reconciliation treat
-- it like a dashboard order. A proposal is submitted at most once.
ALTER TABLE order_intents
  DROP CONSTRAINT order_intents_source_check,
  ADD CONSTRAINT order_intents_source_check CHECK (
    proposal_id IS NOT NULL
      OR (manual_order IS NOT NULL AND exchange_account_id IS NOT NULL)
  );

CREATE UNIQUE INDEX order_intents_proposal_id_key
  ON order_intents (proposal_id) WHERE proposal_id IS NOT NULL;
