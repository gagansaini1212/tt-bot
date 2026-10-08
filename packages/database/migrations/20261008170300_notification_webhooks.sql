-- A customer's Discord or Telegram webhook for their alerts. The URL carries
-- the webhook's token, so it is a secret: the worker seals it with AES-256-GCM
-- like exchange keys, binding the customer and webhook in as associated data.
-- Runs after 20261008170000_notifications, which creates that table.
CREATE TABLE notification_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id),
  kind text NOT NULL CHECK (kind IN ('discord', 'telegram')),
  encrypted_url bytea NOT NULL,
  -- Shown on the Settings page in place of the URL.
  url_last4 text NOT NULL CHECK (char_length(url_last4) <= 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_isolation ON notification_webhooks
  USING (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid)
  WITH CHECK (customer_id = nullif(current_setting('app.current_customer_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_webhooks TO trading_app;

-- Every new notification queues one delivery job per webhook of its customer,
-- in the same transaction, whoever writes the notification. The worker
-- delivers notification.webhook jobs and retries them with backoff. The
-- function runs as the role inserting the notification, so row-level security
-- limits it to that customer's webhook and outbox. Webhooks are optional: if
-- queueing fails, the alert is still saved, and the failure is a warning in
-- PostgreSQL's log.
CREATE FUNCTION enqueue_notification_webhooks() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
BEGIN
  INSERT INTO public.outbox_jobs (customer_id, topic, deduplication_key, payload)
  SELECT
    NEW.customer_id,
    'notification.webhook',
    'notification.webhook:' || NEW.id || ':' || webhook.id,
    jsonb_build_object('notificationId', NEW.id, 'webhookId', webhook.id)
  FROM public.notification_webhooks AS webhook
  WHERE webhook.customer_id = NEW.customer_id
  ON CONFLICT (deduplication_key) DO NOTHING;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Notification % was saved, but its webhook deliveries could not be queued: %',
    NEW.id, SQLERRM;
  RETURN NULL;
END
$$;

CREATE TRIGGER notifications_enqueue_webhooks
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION enqueue_notification_webhooks();
