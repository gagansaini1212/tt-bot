-- Customer sign-in (#35). Better Auth keeps logins, their sessions and their
-- passwords in these tables, and apps/web/src/lib/auth-options.ts maps its
-- models onto them. Better Auth checks the tables match when it starts.
--
-- Each login acts for one customer. Better Auth finds a session by its token,
-- and a login by its email, before anyone knows which customer is asking, so
-- these tables cannot have customer_isolation policies. Instead only
-- trading_auth may use them, and trading_app and trading_worker may not:
-- the code that handles trading data never sees passwords or session tokens.
DO $$
BEGIN
  CREATE ROLE trading_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'trading_auth' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'trading_auth must not bypass row-level security';
  END IF;
END
$$;

CREATE TABLE auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_users_customer_id_idx ON auth_users(customer_id);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts(user_id);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);

GRANT USAGE ON SCHEMA public TO trading_auth;

-- There is no sign-up: logins are created by the schema owner (pnpm db:seed
-- locally). Better Auth may change a login's profile and password, but never
-- the customer it acts for, or which login a password belongs to.
GRANT SELECT, UPDATE (name, email, email_verified, image, updated_at)
  ON auth_users TO trading_auth;
GRANT SELECT, UPDATE (password, updated_at) ON auth_accounts TO trading_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions, auth_verifications
  TO trading_auth;
