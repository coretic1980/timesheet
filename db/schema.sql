-- Wordt bij elke start uitgevoerd; alle statements zijn idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  weekly_hours  NUMERIC(4,1) NOT NULL DEFAULT 40,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tweestapsverificatie (TOTP)
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;          -- versleuteld
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;  -- versleuteld, tijdens instellen
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;     -- voorkomt hergebruik van een code
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes TEXT[];     -- sha256-hashes

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,               -- sha256 van het cookie-token
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
-- Sessie na wachtwoord maar vóór de 2FA-code (kort geldig, geeft geen toegang)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_mfa BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_attempts INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS clients (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  eb_relation_id   INT,                       -- interne id van de relatie in e-Boekhouden
  eb_relation_code TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Factuurregels per klant (NULL = standaardinstelling)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS invoice_line_mode TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS invoice_line_format TEXT;

CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  client_id    INT REFERENCES clients(id),    -- NULL = intern project
  name         TEXT NOT NULL,
  code         TEXT,
  default_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  budget_hours NUMERIC(8,2),
  billable     BOOLEAN NOT NULL DEFAULT TRUE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rate       NUMERIC(10,2),                   -- NULL = projecttarief
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS activities (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  default_rate NUMERIC(10,2),                 -- NULL = tarief van medewerker/project
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS activities_name_idx ON activities (lower(name));

CREATE TABLE IF NOT EXISTS project_activities (
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id INT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  rate        NUMERIC(10,2),                  -- afwijkend tarief op dit project
  PRIMARY KEY (project_id, activity_id)
);

-- PO-nummer / referentie per project (wordt de factuurreferentie)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reference TEXT;

-- Budget per activiteit op een project (uren en/of bedrag excl. btw)
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS budget_hours NUMERIC(8,2);
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS budget_amount NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS invoices (
  id                SERIAL PRIMARY KEY,
  client_id         INT NOT NULL REFERENCES clients(id),
  eb_invoice_id     INT,
  eb_invoice_number TEXT,
  pdf_url           TEXT,
  period_from       DATE NOT NULL,
  period_to         DATE NOT NULL,
  hours             NUMERIC(10,2) NOT NULL,
  total_excl        NUMERIC(12,2) NOT NULL,
  created_by        INT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Teruggedraaide facturen (uren weer vrijgegeven om opnieuw te factureren)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reverted_by INT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS time_entries (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id),
  project_id       INT NOT NULL REFERENCES projects(id),
  activity_id      INT REFERENCES activities(id),
  work_date        DATE NOT NULL,
  hours            NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'invoiced')),
  rejection_reason TEXT,
  rate             NUMERIC(10,2),             -- vastgelegd bij goedkeuring
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  invoice_id       INT REFERENCES invoices(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bestaande installaties: kolom toevoegen en uniciteit uitbreiden met de activiteit.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS activity_id INT REFERENCES activities(id);
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_user_id_project_id_work_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_cell_idx
  ON time_entries (user_id, project_id, (COALESCE(activity_id, 0)), work_date);
CREATE INDEX IF NOT EXISTS time_entries_status_idx ON time_entries(status);
CREATE INDEX IF NOT EXISTS time_entries_date_idx ON time_entries(work_date);
CREATE INDEX IF NOT EXISTS time_entries_project_idx ON time_entries(project_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
