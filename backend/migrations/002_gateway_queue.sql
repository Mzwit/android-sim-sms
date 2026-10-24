-- =====================================================================
-- 002: gateway runtime, imports, alerts, queue bookkeeping
-- =====================================================================

-- ---------- gateways ---------------------------------------------------
ALTER TABLE gateways
  ADD COLUMN pause_reason       text,
  ADD COLUMN emergency_stop_at  timestamptz,
  ADD COLUMN last_health        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_ip            inet,
  ADD COLUMN revoked_at         timestamptz,
  ADD COLUMN offline_alerted_at timestamptz;

-- ---------- submission attempts ---------------------------------------
-- NOT_SENT: the phone confirms it never handed the message to the radio
-- (lease released, expired before confirmation, or dropped by emergency stop).
ALTER TABLE sms_submission_attempts DROP CONSTRAINT sms_submission_attempts_outcome_check;
ALTER TABLE sms_submission_attempts ADD CONSTRAINT sms_submission_attempts_outcome_check
  CHECK (outcome IN ('PENDING','SUBMITTED','FAILED','UNKNOWN','NOT_SENT'));
ALTER TABLE sms_submission_attempts
  ADD COLUMN confirmed_at   timestamptz,          -- server allowed this attempt to be sent
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN parts_failed   smallint NOT NULL DEFAULT 0,
  ADD COLUMN detail         text;
CREATE INDEX idx_attempts_pending ON sms_submission_attempts(gateway_id) WHERE outcome = 'PENDING';

-- Per-part sent results, so duplicate callbacks are idempotent.
CREATE TABLE sms_part_results (
  attempt_id  uuid NOT NULL REFERENCES sms_submission_attempts(id) ON DELETE CASCADE,
  part_index  smallint NOT NULL,
  result_code integer NOT NULL,
  ok          boolean NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, part_index)
);

-- ---------- messages ---------------------------------------------------
ALTER TABLE messages ADD COLUMN contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_contact ON messages(contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_messages_unknown ON messages(updated_at DESC) WHERE status = 'UNKNOWN';
CREATE INDEX idx_messages_dead ON messages(dead_lettered_at DESC) WHERE dead_lettered_at IS NOT NULL;
CREATE INDEX idx_messages_submitted_at ON messages(submitted_at) WHERE submitted_at IS NOT NULL;

-- ---------- campaigns --------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN cooldown_until      timestamptz,
  ADD COLUMN sent_since_cooldown integer NOT NULL DEFAULT 0,
  ADD COLUMN paused_by           uuid REFERENCES administrators(id),
  ADD COLUMN paused_at           timestamptz,
  ADD COLUMN segments_estimated  integer,
  ADD COLUMN recipients_included integer,
  ADD COLUMN recipients_excluded integer;

-- ---------- contact imports -------------------------------------------
CREATE TABLE contact_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  file_type    text NOT NULL CHECK (file_type IN ('CSV','XLSX')),
  country      text NOT NULL,
  status       text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED','COMMITTED','DISCARDED')),
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb,
  uploaded_by  uuid NOT NULL REFERENCES administrators(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE contact_import_rows (
  import_id           uuid NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  row_no              integer NOT NULL,           -- 1-based data row (header excluded)
  phone_raw           text,
  phone_e164          text,
  first_name          text,
  last_name           text,
  reference_no        text,
  email               text,
  tags                text[] NOT NULL DEFAULT '{}',
  consent_source      text,
  consent_date        timestamptz,
  error_code          text,
  error_message       text,
  duplicate_of_row    integer,
  existing_contact_id uuid,
  PRIMARY KEY (import_id, row_no)
);
CREATE INDEX idx_import_rows_phone ON contact_import_rows(import_id, phone_e164);

-- ---------- alerts -----------------------------------------------------
CREATE TABLE alerts (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  severity        text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  kind            text NOT NULL,
  message         text NOT NULL,
  entity_type     text,
  entity_id       text,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES administrators(id)
);
CREATE INDEX idx_alerts_open ON alerts(created_at DESC) WHERE acknowledged_at IS NULL;

-- ---------- settings ---------------------------------------------------
INSERT INTO app_settings (key, value) VALUES
  ('opt_out_keywords',       '["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT","OPTOUT","OPT OUT"]'),
  ('gateway_offline_minutes','5'),
  ('retry_policy',           '{"base_seconds": 60, "max_seconds": 1800}'),
  ('sending_confirm_grace_seconds', '120')
ON CONFLICT (key) DO NOTHING;

-- ---------- erasure support -------------------------------------------
-- An erased contact's finished messages keep their counts but lose the number.
ALTER TABLE messages ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_phone_required_unless_final
  CHECK (phone_e164 IS NOT NULL OR status IN ('SUBMITTED','DELIVERED','FAILED','CANCELLED'));
ALTER TABLE contacts ADD COLUMN erased_at timestamptz;
