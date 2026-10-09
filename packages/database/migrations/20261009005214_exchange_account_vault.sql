-- Several exchange accounts per customer, on any venue, each with its own
-- credential set (#24, ADR 0009). Existing accounts and their saved keys
-- keep working: every change below widens a constraint or adds a column.

-- An account the customer removed is kept, marked 'disconnected', so its
-- orders, fills and audit trail still name it. Its keys are deleted. The
-- worker never resolves, trades or reconciles a disconnected account, nor a
-- handed-over one.
ALTER TABLE exchange_accounts
  DROP CONSTRAINT exchange_accounts_status_check,
  ADD CONSTRAINT exchange_accounts_status_check CHECK (status IN (
    'connected', 'reconciling', 'unavailable', 'handed_over', 'disconnected'
  )),
  ADD COLUMN disconnected_at timestamptz,
  ADD CONSTRAINT exchange_accounts_disconnected_check
    CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL)),
  -- What the venue's adapter declared it supports (VenueCapabilities in
  -- packages/exchanges), as of when the account last connected: added, given
  -- new keys, or tested. Null until then. Order paths check the adapter
  -- itself; this is the account's record of it.
  ADD COLUMN supported_features jsonb
    CONSTRAINT exchange_accounts_supported_features_object
      CHECK (jsonb_typeof(supported_features) = 'object'),
  ADD COLUMN supported_features_refreshed_at timestamptz,
  -- Live trading stays disabled, so only a read-only venue's account may be
  -- live: one whose recorded features say so.
  ADD CONSTRAINT exchange_accounts_live_read_only CHECK (
    mode = 'simulation'
    OR supported_features ->> 'access' IS NOT DISTINCT FROM 'read_only'
  ),
  ADD CONSTRAINT exchange_accounts_label_check
    CHECK (char_length(label) BETWEEN 1 AND 64 AND label = btrim(label));

-- The customer tells accounts apart by their label.
CREATE UNIQUE INDEX exchange_accounts_label_key
  ON exchange_accounts (customer_id, lower(label))
  WHERE status NOT IN ('disconnected', 'handed_over');

-- es256: the secret is an unencrypted PEM P-256 private key that signs JWTs,
-- as Coinbase's keys do. A venue that needs a passphrase, as OKX does, keeps
-- it sealed in encrypted_passphrase.
--
-- api_key_fingerprint is an HMAC of the venue and the API key under a key
-- derived from the master key. One API key belongs to one exchange account,
-- so the same venue account cannot be connected twice and its capital
-- counted twice (ADR 0009). Keys saved before it existed have none until
-- they are replaced.
ALTER TABLE exchange_credentials
  DROP CONSTRAINT exchange_credentials_key_type_check,
  ADD CONSTRAINT exchange_credentials_key_type_check
    CHECK (key_type IN ('hmac', 'ed25519', 'rsa', 'es256')),
  ADD COLUMN api_key_fingerprint bytea
    CONSTRAINT exchange_credentials_api_key_fingerprint_key UNIQUE;
