-- =====================================================================
-- Android SIM SMS Gateway — initial schema
-- PostgreSQL 14+ (gen_random_uuid is built in from PG13)
-- Every table carries timestamps; all FKs are explicit; states are
-- enforced with CHECK constraints so bad values can never be written.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- shared helpers -------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. Administrators, roles, permissions, sessions
-- =====================================================================
CREATE TABLE roles (
  id          smallserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id          smallserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id smallint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE administrators (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext NOT NULL UNIQUE,
  display_name         text NOT NULL,
  password_hash        text NOT NULL,
  role_id              smallint NOT NULL REFERENCES roles(id),
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_administrators_updated BEFORE UPDATE ON administrators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Opaque session tokens; only the SHA-256 of the token is stored.
CREATE TABLE admin_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES administrators(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id) WHERE revoked_at IS NULL;

-- =====================================================================
-- 2. Gateways (Android phones), pairing, credentials, health
-- =====================================================================
CREATE TABLE gateways (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','DISABLED','REVOKED')),
  device_model        text,
  android_version     text,
  app_version         text,
  sim_subscription_id integer,          -- Android SubscriptionInfo.subscriptionId
  sim_slot_index      integer,
  sim_display_name    text,
  sim_carrier_name    text,
  is_paused           boolean NOT NULL DEFAULT false,
  send_interval_ms    integer NOT NULL DEFAULT 6000 CHECK (send_interval_ms >= 1000),
  batch_limit         integer NOT NULL DEFAULT 20  CHECK (batch_limit BETWEEN 1 AND 200),
  last_seen_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_gateways_updated BEFORE UPDATE ON gateways
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time pairing codes shown as a QR on the dashboard.
CREATE TABLE gateway_pairing_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   bytea NOT NULL UNIQUE,
  label       text NOT NULL,
  created_by  uuid NOT NULL REFERENCES administrators(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  gateway_id  uuid REFERENCES gateways(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Long-lived device tokens (hash only). A gateway may rotate tokens.
CREATE TABLE gateway_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_id   uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX idx_gateway_credentials_gw ON gateway_credentials(gateway_id) WHERE revoked_at IS NULL;

CREATE TABLE gateway_health_events (
  id             bigserial PRIMARY KEY,
  gateway_id     uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  recorded_at    timestamptz NOT NULL,          -- device clock
  received_at    timestamptz NOT NULL DEFAULT now(),
  kind           text NOT NULL DEFAULT 'HEARTBEAT'
                   CHECK (kind IN ('HEARTBEAT','SIM_CHANGED','PERMISSION_LOST','SERVICE_STARTED',
                                   'SERVICE_STOPPED','EMERGENCY_STOP','ERROR')),
  battery_pct    smallint CHECK (battery_pct BETWEEN 0 AND 100),
  is_charging    boolean,
  signal_level   smallint CHECK (signal_level BETWEEN 0 AND 4),
  signal_dbm     smallint,
  network_type   text,
  service_state  text,
  sim_state      text,
  queue_pending  integer,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_health_gw_time ON gateway_health_events(gateway_id, received_at DESC);

-- =====================================================================
-- 3. Contacts, groups, consent, suppression
-- =====================================================================
CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164       text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_raw        text NOT NULL,
  is_valid         boolean NOT NULL,
  validation_error text,
  first_name       text,
  last_name        text,
  reference_no     text,
  email            citext,
  tags             text[] NOT NULL DEFAULT '{}',
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES administrators(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT contacts_valid_has_e164 CHECK (NOT is_valid OR phone_e164 IS NOT NULL)
);
-- Exact E.164 identity only: numbers that merely *look* similar are never merged.
CREATE UNIQUE INDEX uq_contacts_phone_live ON contacts(phone_e164)
  WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE INDEX idx_contacts_tags ON contacts USING gin(tags);
CREATE INDEX idx_contacts_name ON contacts(lower(coalesce(last_name,'')), lower(coalesce(first_name,'')));
CREATE INDEX idx_contacts_ref ON contacts(reference_no) WHERE reference_no IS NOT NULL;
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contact_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES administrators(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_groups_updated BEFORE UPDATE ON contact_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE group_memberships (
  group_id   uuid NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_by   uuid REFERENCES administrators(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX idx_memberships_contact ON group_memberships(contact_id);

-- Consent history is append-only; the latest row per (contact,purpose) wins.
CREATE TABLE consent_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  purpose      text NOT NULL DEFAULT 'general',
  status       text NOT NULL CHECK (status IN ('GRANTED','WITHDRAWN')),
  source       text NOT NULL,                 -- e.g. 'registration form', 'SMS STOP'
  evidence     text,                          -- reference to form id, file, etc.
  effective_at timestamptz NOT NULL DEFAULT now(),
  recorded_by  uuid REFERENCES administrators(id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_contact ON consent_records(contact_id, purpose, effective_at DESC, recorded_at DESC);

-- Suppression is keyed by phone number so it survives contact deletion/re-import.
CREATE TABLE suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  reason     text NOT NULL CHECK (reason IN ('OPT_OUT','ADMIN','COMPLAINT','INVALID_NUMBER','CARRIER_BLOCK')),
  source     text NOT NULL,
  note       text,
  created_by uuid REFERENCES administrators(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  lifted_by  uuid REFERENCES administrators(id),
  lift_note  text
);
CREATE UNIQUE INDEX uq_suppressions_active ON suppressions(phone_e164) WHERE lifted_at IS NULL;

-- =====================================================================
-- 4. Campaigns
-- =====================================================================
CREATE TABLE campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  body_template          text NOT NULL CHECK (length(body_template) BETWEEN 1 AND 1600),
  consent_purpose        text NOT NULL DEFAULT 'general',
  status                 text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SCHEDULED',
                                             'RUNNING','PAUSED','COMPLETED','CANCELLED')),
  pause_reason           text,
  max_recipients         integer NOT NULL DEFAULT 10000 CHECK (max_recipients > 0),
  budget_segments        integer CHECK (budget_segments > 0),
  cost_per_segment       numeric(10,4) NOT NULL DEFAULT 0 CHECK (cost_per_segment >= 0),
  currency               text NOT NULL DEFAULT 'SZL',
  failure_pause_ratio    numeric(4,3) NOT NULL DEFAULT 0.200 CHECK (failure_pause_ratio > 0 AND failure_pause_ratio <= 1),
  failure_window_size    integer NOT NULL DEFAULT 50 CHECK (failure_window_size >= 5),
  test_message_id        uuid,                           -- FK added after messages exists
  created_by             uuid NOT NULL REFERENCES administrators(id),
  submitted_by           uuid REFERENCES administrators(id),
  approved_by            uuid REFERENCES administrators(id),
  approved_at            timestamptz,
  started_at             timestamptz,
  completed_at           timestamptz,
  cancelled_at           timestamptz,
  cancelled_by           uuid REFERENCES administrators(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaigns_status ON campaigns(status, created_at DESC);
CREATE TRIGGER trg_campaigns_updated BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which groups feed a campaign (resolved into campaign_recipients at approval).
CREATE TABLE campaign_groups (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES contact_groups(id),
  PRIMARY KEY (campaign_id, group_id)
);

CREATE TABLE campaign_schedules (
  campaign_id      uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  start_at         timestamptz,                -- null = start on approval
  timezone         text NOT NULL DEFAULT 'Africa/Mbabane',
  window_start     time NOT NULL DEFAULT '08:00',
  window_end       time NOT NULL DEFAULT '18:00',
  days_of_week     smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',  -- ISO: 1=Mon..7=Sun
  cooldown_every   integer CHECK (cooldown_every > 0),       -- pause after N messages
  cooldown_seconds integer CHECK (cooldown_seconds > 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT window_order CHECK (window_start < window_end),
  CONSTRAINT cooldown_pair CHECK ((cooldown_every IS NULL) = (cooldown_seconds IS NULL))
);

-- Snapshot of every intended recipient with inclusion decision.
CREATE TABLE campaign_recipients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id),
  phone_e164       text,
  decision         text NOT NULL CHECK (decision IN ('INCLUDED','EXCLUDED')),
  exclusion_reason text CHECK (exclusion_reason IN ('INVALID_NUMBER','SUPPRESSED','NO_CONSENT',
                                                    'DUPLICATE_NUMBER','OVER_LIMIT','DELETED')),
  rendered_body    text,
  encoding         text CHECK (encoding IN ('GSM7','UCS2')),
  segment_count    smallint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id),
  CONSTRAINT excluded_has_reason CHECK ((decision = 'EXCLUDED') = (exclusion_reason IS NOT NULL))
);
-- One live message per number per campaign, even if two contacts were somehow linked to it.
CREATE UNIQUE INDEX uq_campaign_recipient_phone ON campaign_recipients(campaign_id, phone_e164)
  WHERE decision = 'INCLUDED';

-- =====================================================================
-- 5. Messages, submission attempts, delivery reports, retries
-- =====================================================================
CREATE TABLE messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id           uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_recipient_id uuid UNIQUE REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  is_test               boolean NOT NULL DEFAULT false,
  phone_e164            text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  body                  text NOT NULL,
  encoding              text NOT NULL CHECK (encoding IN ('GSM7','UCS2')),
  segment_count         smallint NOT NULL CHECK (segment_count BETWEEN 1 AND 20),
  status                text NOT NULL DEFAULT 'QUEUED'
                          CHECK (status IN ('QUEUED','LEASED','SENDING','SUBMITTED','DELIVERED',
                                            'FAILED','UNKNOWN','CANCELLED')),
  delivery_state        text NOT NULL DEFAULT 'NONE'
                          CHECK (delivery_state IN ('NONE','AWAITING_REPORT','NO_REPORT','CONFIRMED','FAILED')),
  priority              smallint NOT NULL DEFAULT 100,   -- lower = sooner; tests use 0
  attempt_count         smallint NOT NULL DEFAULT 0,
  max_attempts          smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  gateway_id            uuid REFERENCES gateways(id),
  lease_id              uuid,
  leased_at             timestamptz,
  lease_expires_at      timestamptz,
  last_error_code       text,
  last_error_category   text CHECK (last_error_category IN ('INVALID_DESTINATION','MISSING_PERMISSION',
                          'SIM_UNAVAILABLE','NETWORK_FAILURE','SERVICE_UNAVAILABLE','RATE_LIMITED',
                          'SUBMISSION_FAILURE','DELIVERY_FAILURE','DELIVERY_UNKNOWN','SUPPRESSED',
                          'CANCELLED','INTERNAL')),
  dead_lettered_at      timestamptz,
  queued_at             timestamptz NOT NULL DEFAULT now(),
  submitted_at          timestamptz,
  delivered_at          timestamptz,
  finalized_at          timestamptz,
  created_by            uuid REFERENCES administrators(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lease_consistency CHECK (
    (status IN ('LEASED','SENDING')) = (lease_id IS NOT NULL AND gateway_id IS NOT NULL)
  )
);
-- Queue pickup: SELECT ... WHERE status='QUEUED' AND next_attempt_at<=now() ORDER BY priority, next_attempt_at FOR UPDATE SKIP LOCKED
CREATE INDEX idx_messages_ready ON messages(priority, next_attempt_at) WHERE status = 'QUEUED';
CREATE INDEX idx_messages_lease_expiry ON messages(lease_expires_at) WHERE status IN ('LEASED','SENDING');
CREATE INDEX idx_messages_campaign_status ON messages(campaign_id, status);
CREATE INDEX idx_messages_phone ON messages(phone_e164, created_at DESC);
CREATE INDEX idx_messages_awaiting_report ON messages(submitted_at) WHERE delivery_state = 'AWAITING_REPORT';
CREATE TRIGGER trg_messages_updated BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE campaigns ADD CONSTRAINT fk_campaign_test_message
  FOREIGN KEY (test_message_id) REFERENCES messages(id) ON DELETE SET NULL;

-- What the handset reported for each attempt (sentIntent callbacks).
CREATE TABLE sms_submission_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attempt_no          smallint NOT NULL,
  gateway_id          uuid NOT NULL REFERENCES gateways(id),
  lease_id            uuid NOT NULL,
  sim_subscription_id integer,
  outcome             text NOT NULL DEFAULT 'PENDING'
                        CHECK (outcome IN ('PENDING','SUBMITTED','FAILED','UNKNOWN','EXPIRED')),
  parts_total         smallint NOT NULL,
  parts_ok            smallint NOT NULL DEFAULT 0,
  android_result_code integer,
  error_code          text,
  error_category      text,
  started_at          timestamptz NOT NULL DEFAULT now(),    -- lease granted
  device_sent_at      timestamptz,                           -- device clock
  reported_at         timestamptz,                           -- received by backend
  UNIQUE (message_id, attempt_no),
  UNIQUE (lease_id, message_id)
);
CREATE INDEX idx_attempts_gateway ON sms_submission_attempts(gateway_id, started_at DESC);

-- Network status reports (deliveryIntent), one row per part.
CREATE TABLE delivery_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attempt_id    uuid NOT NULL REFERENCES sms_submission_attempts(id) ON DELETE CASCADE,
  gateway_id    uuid NOT NULL REFERENCES gateways(id),
  part_index    smallint NOT NULL,
  status        text NOT NULL CHECK (status IN ('DELIVERED','FAILED','PENDING')),
  tp_status     smallint,                                 -- raw TP-Status from the PDU
  device_received_at timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, part_index)
);
CREATE INDEX idx_delivery_message ON delivery_reports(message_id);

CREATE TABLE retry_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('AUTO','MANUAL','RECONCILE_RESEND')),
  reason       text NOT NULL,
  requested_by uuid REFERENCES administrators(id),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_retry_message ON retry_jobs(message_id, created_at DESC);

-- Admin decisions on UNKNOWN messages.
CREATE TABLE reconciliations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  decision    text NOT NULL CHECK (decision IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT','RESEND','ABANDON')),
  note        text NOT NULL,
  decided_by  uuid NOT NULL REFERENCES administrators(id),
  decided_at  timestamptz NOT NULL DEFAULT now()
);

-- Segments submitted per day per gateway, used for the daily airtime budget.
CREATE TABLE daily_usage (
  usage_date         date NOT NULL,
  gateway_id         uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  segments_submitted integer NOT NULL DEFAULT 0,
  messages_submitted integer NOT NULL DEFAULT 0,
  PRIMARY KEY (usage_date, gateway_id)
);

-- =====================================================================
-- 6. Idempotency, audit, settings
-- =====================================================================
CREATE TABLE idempotency_keys (
  admin_id        uuid NOT NULL REFERENCES administrators(id) ON DELETE CASCADE,
  idem_key        text NOT NULL CHECK (length(idem_key) BETWEEN 8 AND 128),
  route           text NOT NULL,
  request_hash    bytea NOT NULL,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, idem_key)
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('ADMIN','GATEWAY','SYSTEM')),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  ip          inet,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_audit_time ON audit_logs(occurred_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, occurred_at DESC);

-- Audit log is append-only. Deletion is only possible through the retention
-- purge, which sets app.audit_purge='on' inside its own transaction.
CREATE OR REPLACE FUNCTION audit_logs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.audit_purge', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_logs rows can only be removed by the retention purge';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_guard BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES administrators(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 7. Seed: permissions, roles, default settings
-- =====================================================================
INSERT INTO permissions (code, description) VALUES
  ('contacts.read',          'View contacts with masked phone numbers'),
  ('contacts.read_full',     'View full, unmasked phone numbers'),
  ('contacts.write',         'Create, edit and import contacts'),
  ('contacts.delete',        'Delete contacts'),
  ('contacts.export',        'Export contacts to CSV'),
  ('groups.write',           'Create and edit contact groups'),
  ('consent.write',          'Record consent and opt-outs, manage suppression'),
  ('campaigns.read',         'View campaigns and reports'),
  ('campaigns.write',        'Create and edit draft campaigns'),
  ('campaigns.approve',      'Approve campaigns for sending'),
  ('campaigns.operate',      'Start, pause, resume and cancel campaigns'),
  ('messages.retry',         'Retry failed messages and reconcile UNKNOWN ones'),
  ('reports.export',         'Export campaign reports'),
  ('gateways.read',          'View gateways and health'),
  ('gateways.manage',        'Pair, configure, pause and revoke gateways'),
  ('audit.read',             'View the audit log'),
  ('settings.write',         'Change application settings and kill switch'),
  ('admins.manage',          'Manage administrator accounts');

INSERT INTO roles (code, name, description, is_system) VALUES
  ('SUPER_ADMIN',      'Super administrator', 'Full access', true),
  ('CAMPAIGN_MANAGER', 'Campaign manager',    'Manages contacts and campaigns, can approve', true),
  ('OPERATOR',         'Operator',            'Prepares campaigns and runs approved ones', true),
  ('AUDITOR',          'Auditor',             'Read-only access including the audit log', true),
  ('VIEWER',           'Viewer',              'Read-only access to masked data', true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'SUPER_ADMIN';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ANY (CASE r.code
  WHEN 'CAMPAIGN_MANAGER' THEN ARRAY['contacts.read','contacts.read_full','contacts.write','contacts.delete',
       'contacts.export','groups.write','consent.write','campaigns.read','campaigns.write','campaigns.approve',
       'campaigns.operate','messages.retry','reports.export','gateways.read','audit.read']
  WHEN 'OPERATOR' THEN ARRAY['contacts.read','contacts.write','groups.write','consent.write','campaigns.read',
       'campaigns.write','campaigns.operate','gateways.read']
  WHEN 'AUDITOR'  THEN ARRAY['contacts.read','campaigns.read','reports.export','gateways.read','audit.read']
  WHEN 'VIEWER'   THEN ARRAY['contacts.read','campaigns.read','gateways.read']
  ELSE ARRAY[]::text[] END)
WHERE r.code <> 'SUPER_ADMIN';

INSERT INTO app_settings (key, value) VALUES
  ('kill_switch',                 '{"enabled": false, "reason": null}'),
  ('default_country',             '"SZ"'),
  ('daily_segment_budget',        '2000'),
  ('require_separate_approver',   'false'),
  ('require_test_before_approval','true'),
  ('delivery_report_timeout_hours','48'),
  ('lease_seconds',               '300'),
  ('max_campaign_recipients',     '20000'),
  ('retention',                   '{"messages_days": 365, "health_days": 30, "audit_days": 1095, "sessions_days": 30}'),
  ('test_numbers',                '[]');
