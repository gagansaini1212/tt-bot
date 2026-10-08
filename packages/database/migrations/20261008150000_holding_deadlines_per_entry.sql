-- ADR 0004: a strategy's position can hold several protected entries, each
-- with its own holding deadline from its own first fill. A deadline belongs
-- to its entry's order intent, one per entry, and still names the position,
-- which may now have several. Nothing has written this table yet, so the new
-- column can be required.
ALTER TABLE holding_deadlines
  DROP CONSTRAINT holding_deadlines_position_ownership_id_key,
  ADD COLUMN order_intent_id uuid NOT NULL,
  ADD CONSTRAINT holding_deadlines_order_intent_id_key UNIQUE (order_intent_id),
  ADD CONSTRAINT holding_deadlines_order_intent_fkey
    FOREIGN KEY (customer_id, order_intent_id)
    REFERENCES order_intents (customer_id, id);

CREATE INDEX holding_deadlines_position_idx
  ON holding_deadlines (position_ownership_id);
