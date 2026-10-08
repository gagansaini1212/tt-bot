CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX notifications_customer_created_idx
  ON notifications (customer_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON notifications
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON notifications TO trading_app;
