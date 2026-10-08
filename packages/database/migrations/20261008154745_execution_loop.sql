-- The execution worker's loop (#42, #43). It reconciles each protected entry
-- with Binance, sells quantity no stop loss protects, enforces holding
-- deadlines, and sends stop-limit entries it holds once their stop trades.

-- A market sell the worker sends to close a protected entry is an order
-- intent of its own, saved before it is sent like every other order, and
-- names the entry it closes. A stop-limit entry the worker holds is an intent
-- with status 'pending' until its stop price trades.
ALTER TABLE order_intents
  ADD COLUMN closes_order_intent_id uuid,
  ADD CONSTRAINT order_intents_closes_fkey
    FOREIGN KEY (customer_id, closes_order_intent_id)
    REFERENCES order_intents (customer_id, id);

CREATE INDEX order_intents_closes_idx
  ON order_intents (closes_order_intent_id)
  WHERE closes_order_intent_id IS NOT NULL;

CREATE INDEX order_intents_pending_idx
  ON order_intents (customer_id)
  WHERE status = 'pending';

-- The loop's latest finding for each protected entry it has reconciled.
--   working        the entry rests on the book; nothing has filled
--   partly_filled  part has filled; Binance places exits once all of it has
--   awaiting_exits it has filled; Binance has not confirmed its exits yet
--   protected      it has filled, and its stop loss covers what it holds
--   unprotected    it holds quantity no stop loss protects; the worker is
--                  cancelling what is left of it and selling that quantity
--   exiting        the worker is selling it for another reason (exit_reason)
--   closed         it holds nothing any more (terminal)
--   not_filled     it ended without filling (terminal)
--   handed_over    the customer cancelled it from the dashboard, accepting
--                  that its filled quantity is left without exits (terminal)
--   missing        Binance has no record of it, such as after a testnet
--                  reset (terminal)
CREATE TABLE entry_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_intent_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'working', 'partly_filled', 'awaiting_exits', 'protected', 'unprotected',
    'exiting', 'closed', 'not_filled', 'handed_over', 'missing'
  )),
  filled_quantity numeric(38, 18) NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  held_quantity numeric(38, 18) NOT NULL DEFAULT 0 CHECK (held_quantity >= 0),
  first_fill_at timestamptz,
  -- Set once the worker decides to sell the entry, and why. Callers such as
  -- a strategy's close all may set it too; the loop carries it out.
  exit_reason text CHECK (exit_reason ~ '^[a-z_]{1,40}$'),
  exit_requested_at timestamptz,
  -- Set when the worker stops trying to sell, after repeated failures.
  close_blocked_at timestamptz,
  -- Set just before the customer cancels an entry's order list from the
  -- dashboard, having confirmed that the quantity it bought is left without
  -- exits, with the quantity they accepted.
  customer_cancelled_at timestamptz,
  customer_accepted_quantity numeric(38, 18)
    CHECK (customer_accepted_quantity > 0),
  -- Market sells Binance refused only because of a rate limit. They do not
  -- count towards the attempts after which the worker stops selling.
  rate_limited_sells integer NOT NULL DEFAULT 0 CHECK (rate_limited_sells >= 0),
  detail text NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, order_intent_id)
    REFERENCES order_intents (customer_id, id)
);

CREATE INDEX entry_reconciliations_open_idx
  ON entry_reconciliations (customer_id)
  WHERE state NOT IN ('closed', 'not_filled', 'handed_over', 'missing');

CREATE INDEX holding_deadlines_due_idx
  ON holding_deadlines (deadline_at)
  WHERE status IN ('pending', 'triggered', 'overdue');

ALTER TABLE entry_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON entry_reconciliations
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON entry_reconciliations TO trading_app;
