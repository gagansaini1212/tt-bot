-- API keys an exchange account trades with, entered on the Settings page.
-- Only the execution worker reads or writes them. Each secret is sealed with
-- AES-256-GCM under the worker's CREDENTIALS_MASTER_KEY, with a fresh nonce
-- per seal and the customer, exchange account and column bound in as
-- associated data, so a sealed value cannot be moved to another account or
-- column. See apps/execution/src/secret-box.ts.
--
-- One row per exchange account. Other exchanges (#24) add rows with their
-- own key types, and a passphrase where they need one.
CREATE TABLE exchange_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  exchange_account_id uuid NOT NULL UNIQUE,
  -- hmac: the secret is an HMAC secret key. ed25519, rsa: the secret is an
  -- unencrypted PEM private key whose public key is registered with the
  -- exchange.
  key_type text NOT NULL CHECK (key_type IN ('hmac', 'ed25519', 'rsa')),
  encrypted_api_key bytea NOT NULL,
  encrypted_api_secret bytea NOT NULL,
  encrypted_passphrase bytea,
  -- Shown on the Settings page in place of the key.
  api_key_last4 text NOT NULL CHECK (char_length(api_key_last4) <= 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, id),
  FOREIGN KEY (customer_id, exchange_account_id)
    REFERENCES exchange_accounts (customer_id, id)
);

ALTER TABLE exchange_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON exchange_credentials
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

-- Removing keys deletes their ciphertext rather than keeping it.
GRANT SELECT, INSERT, UPDATE, DELETE ON exchange_credentials TO trading_app;
