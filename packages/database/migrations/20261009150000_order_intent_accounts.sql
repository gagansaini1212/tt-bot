-- Order intents across venues and exchange accounts (ADR 0008, ADR 0009,
-- issue #22). An intent's idempotency key is the application's order ID: the
-- client order ID its venue knows, or its order list's, translated by the
-- venue's ClientOrderIdCodec. The key is already unique across every
-- customer, account and venue. This makes sure each key belongs to exactly
-- one exchange account, and so one venue, and that no key can be mistaken
-- for another order's leg or close ID.

-- Every intent names its exchange account. Intents made from a proposal
-- before every intent recorded its account take their proposal's.
UPDATE order_intents i
SET exchange_account_id = p.exchange_account_id
FROM trade_proposals p
WHERE p.id = i.proposal_id AND i.exchange_account_id IS NULL;

ALTER TABLE order_intents ALTER COLUMN exchange_account_id SET NOT NULL;

-- An intent made from a proposal is on the proposal's account. Every intent
-- was saved that way, but rows from before are not read again: the key is
-- checked for new rows and changed keys.
ALTER TABLE trade_proposals
  ADD CONSTRAINT trade_proposals_id_exchange_account_key
    UNIQUE (id, exchange_account_id);

ALTER TABLE order_intents
  ADD CONSTRAINT order_intents_proposal_account_fkey
    FOREIGN KEY (proposal_id, exchange_account_id)
    REFERENCES trade_proposals (id, exchange_account_id)
    NOT VALID;

-- A protected entry's legs are its key with _en, _tp or _sl, and the
-- worker's sells closing it are intents keyed by its key with _c1 to _c9
-- (protectedLegIds and closeOrderId in packages/exchanges). So a key may end
-- like that only if it is such a sell, of the entry it names: otherwise one
-- client order ID could name two orders, on two accounts or venues alike.
-- Checked when a key is written, so rows saved before are left as they are.
CREATE FUNCTION order_intent_key_is_unambiguous() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manual_order ->> 'kind' = 'exit' THEN
    IF NEW.idempotency_key !~ '^ct_[A-Za-z0-9_-]{1,30}_c[1-9]$'
      OR left(NEW.idempotency_key, -3) ~ '_(en|tp|sl|c[1-9])$'
      OR NEW.closes_order_intent_id IS NULL
      OR left(NEW.idempotency_key, -3) IS DISTINCT FROM (
        SELECT idempotency_key FROM order_intents
        WHERE id = NEW.closes_order_intent_id
          AND exchange_account_id = NEW.exchange_account_id
      )
    THEN
      RAISE EXCEPTION 'An exit''s key is the key of the entry it closes, on the same exchange account, with _c1 to _c9.'
        USING ERRCODE = 'check_violation',
          CONSTRAINT = 'order_intents_key_unambiguous';
    END IF;
  ELSIF NEW.idempotency_key !~ '^ct_[A-Za-z0-9_-]{1,33}$'
    OR NEW.idempotency_key ~ '_(en|tp|sl|c[1-9])$'
  THEN
    RAISE EXCEPTION 'An order intent''s key may not end like a leg or exit ID (_en, _tp, _sl, _c1 to _c9).'
      USING ERRCODE = 'check_violation',
        CONSTRAINT = 'order_intents_key_unambiguous';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER order_intents_key_unambiguous
  BEFORE INSERT OR UPDATE OF idempotency_key ON order_intents
  FOR EACH ROW EXECUTE FUNCTION order_intent_key_is_unambiguous();
