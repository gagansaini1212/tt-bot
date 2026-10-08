-- The strategy engine (#16). The execution worker runs each strategy's rules
-- on every pass: it plans protected entries, checks them, reserves their
-- budget and places them, and measures loss limits. See ADR 0004.

-- What the worker and the customer did to a strategy, and what it is waiting
-- for. A strategy's status stays the customer's view of it: Running is
-- simulation or active, Paused is paused and Completed is retired.
ALTER TABLE strategies
  -- Why it is paused: customer, close_all, loss_limit, drawdown,
  -- kill_switch or protection_failed.
  ADD COLUMN pause_reason text CHECK (pause_reason ~ '^[a-z_]{1,40}$'),
  ADD COLUMN paused_at timestamptz,
  -- The exit every entry of the strategy gets, until the customer resumes
  -- it: pause, or a reason that also sells what the entries hold, such as
  -- close_all or loss_limit. The worker applies it on every pass, so an
  -- entry sent while the request was made is stopped too.
  ADD COLUMN exit_request text CHECK (exit_request ~ '^[a-z_]{1,40}$'),
  -- The rules open no more entries: an expiry, the end of a DCA schedule, a
  -- standing instruction that filled, or a grid that left its range. The
  -- strategy completes once it holds nothing. A new version clears it.
  ADD COLUMN rules_ended_at timestamptz,
  ADD COLUMN rules_ended_reason text CHECK (rules_ended_reason ~ '^[a-z_]{1,40}$'),
  ADD COLUMN completed_at timestamptz,
  -- The worker's latest note on what the strategy is doing or waiting for.
  ADD COLUMN runner_note text NOT NULL DEFAULT '' CHECK (char_length(runner_note) <= 500),
  ADD COLUMN runner_checked_at timestamptz,
  -- When an AI-managed strategy's next scheduled analysis is due. The worker
  -- claims each one by moving this forward, so two workers never both ask.
  ADD COLUMN next_analysis_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- An AI-managed strategy's version also says whether the customer approves
-- each proposal or the worker submits it within the limits, and how often
-- the AI is asked. Other kinds have neither.
ALTER TABLE strategy_versions
  ADD COLUMN proposal_approval text
    CHECK (proposal_approval IN ('required', 'automatic')),
  ADD COLUMN analysis_interval_minutes integer
    CHECK (analysis_interval_minutes BETWEEN 15 AND 1440),
  ADD CONSTRAINT strategy_versions_ai_settings_check CHECK (
    (rules ->> 'kind' = 'ai_managed')
      = (proposal_approval IS NOT NULL AND analysis_interval_minutes IS NOT NULL)
  );

-- Each of a strategy's protected entries is a trade proposal with an order
-- intent. entry_key names what it fills within the rules (a grid level, a
-- DCA buy, a standing entry; 'ai' for the AI's proposals), and entry_attempt
-- counts the entries made for that key, so two workers cannot both make the
-- same one.
ALTER TABLE trade_proposals
  ADD COLUMN entry_key text CHECK (entry_key ~ '^[a-z]+(:[0-9]{1,4})?$'),
  ADD COLUMN entry_attempt integer CHECK (entry_attempt > 0),
  ADD CONSTRAINT trade_proposals_entry_key_pair_check
    CHECK ((entry_key IS NULL) = (entry_attempt IS NULL)),
  ADD CONSTRAINT trade_proposals_entry_key_owner_check
    CHECK (entry_key IS NULL OR strategy_id IS NOT NULL);

CREATE UNIQUE INDEX trade_proposals_strategy_entry_key
  ON trade_proposals (strategy_id, entry_key, entry_attempt)
  WHERE entry_key IS NOT NULL;

CREATE INDEX trade_proposals_strategy_idx
  ON trade_proposals (strategy_id)
  WHERE strategy_id IS NOT NULL;

-- An AI-managed strategy's decisions name it, so its card can show the
-- latest one and its proposals wait for the customer under its limits.
ALTER TABLE ai_decisions
  ADD COLUMN strategy_id uuid,
  ADD CONSTRAINT ai_decisions_strategy_fkey
    FOREIGN KEY (customer_id, strategy_id)
    REFERENCES strategies (customer_id, id);

CREATE INDEX ai_decisions_strategy_idx
  ON ai_decisions (strategy_id, created_at DESC)
  WHERE strategy_id IS NOT NULL;

-- One allocation per strategy. A new version may change its amount.
CREATE UNIQUE INDEX allocations_strategy_key
  ON allocations (strategy_id)
  WHERE strategy_id IS NOT NULL;

CREATE INDEX budget_reservations_open_idx
  ON budget_reservations (allocation_id)
  WHERE status <> 'released';

-- The portfolio's maximum daily drawdown: the loss since midnight UTC of
-- every strategy on the exchange account together, as a percentage of their
-- allocations. Reaching it pauses every strategy. Each change adds a version.
CREATE TABLE portfolio_risk_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  max_daily_drawdown_percent numeric(7, 4) NOT NULL
    CHECK (max_daily_drawdown_percent > 0 AND max_daily_drawdown_percent <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_account_id, version),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts (customer_id, id)
);

ALTER TABLE portfolio_risk_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON portfolio_risk_limits
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

-- Versions are immutable.
GRANT SELECT, INSERT ON portfolio_risk_limits TO trading_app;
