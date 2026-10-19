-- Wordt bij elke start uitgevoerd; alle statements zijn idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee',
  weekly_hours  NUMERIC(4,1) NOT NULL DEFAULT 40,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rollen: beheerder, medewerker en accountant (alleen inzien)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'employee', 'accountant'));

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
-- Factuurdatum zoals naar e-Boekhouden gestuurd (oudere facturen: aanmaakdatum)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_date DATE;

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

-- Logboek van financieel relevante handelingen (goedkeuren, factureren, tarieven, rechten).
-- Alleen toevoegen; de app wijzigt of verwijdert hier niets.
CREATE TABLE IF NOT EXISTS audit_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id  INT REFERENCES users(id),
  action   TEXT NOT NULL,
  summary  TEXT NOT NULL,
  details  JSONB
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at);

-- Ingehuurde zzp'ers: leveranciersgegevens voor zelffacturering (factuur uitgereikt door afnemer).
CREATE TABLE IF NOT EXISTS contractors (
  user_id          INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name     TEXT NOT NULL,
  address          TEXT,
  postal_code      TEXT,
  city             TEXT,
  kvk              TEXT,
  vat_number       TEXT,
  iban             TEXT,
  vat_mode         TEXT NOT NULL DEFAULT 'hoog' CHECK (vat_mode IN ('hoog', 'kor', 'verlegd')),
  default_cost_rate NUMERIC(10,2),             -- inkooptarief per uur excl. btw
  agreement_date   DATE,                       -- datum akkoord zelffacturering
  payment_term     INT NOT NULL DEFAULT 30,
  eb_relation_id   INT,                        -- crediteur in e-Boekhouden
  eb_relation_code TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inkooptarief per project (leeg = standaard inkooptarief van de zzp'er)
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS cost_rate NUMERIC(10,2);

CREATE TABLE IF NOT EXISTS self_bills (
  id             SERIAL PRIMARY KEY,
  user_id        INT NOT NULL REFERENCES users(id),
  number         TEXT NOT NULL UNIQUE,
  bill_date      DATE NOT NULL,
  period_from    DATE NOT NULL,
  period_to      DATE NOT NULL,
  hours          NUMERIC(10,2) NOT NULL,
  total_excl     NUMERIC(12,2) NOT NULL,
  vat_mode       TEXT NOT NULL,
  vat_rate       NUMERIC(5,2) NOT NULL,
  vat_amount     NUMERIC(12,2) NOT NULL,
  total_incl     NUMERIC(12,2) NOT NULL,
  snapshot       JSONB NOT NULL,              -- leverancier, afnemer en regels zoals uitgereikt
  eb_mutation_id INT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'disputed')),
  status_at      TIMESTAMPTZ,
  dispute_reason TEXT,
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at    TIMESTAMPTZ,
  reverted_by    INT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS self_bills_user_idx ON self_bills(user_id);

-- Inkooptarief vastgelegd bij goedkeuring, en op welke zelffactuur de uren staan
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS cost_rate NUMERIC(10,2);
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS self_bill_id INT REFERENCES self_bills(id);
CREATE INDEX IF NOT EXISTS time_entries_self_bill_idx ON time_entries(self_bill_id);

-- Inhuur van zzp'ers: dossier per opdracht (intake, overeenkomst, documenten, praktijkchecks).
-- Een zzp'er kan pas uren schrijven als een gekoppeld dossier is vrijgegeven (status 'actief'),
-- en alleen binnen de looptijd van die opdracht.
CREATE TABLE IF NOT EXISTS onboarding_dossiers (
  id             SERIAL PRIMARY KEY,
  user_id        INT REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'intake'
                 CHECK (status IN ('intake', 'contract', 'actief', 'afgerond', 'afgewezen')),
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  invite_hash    TEXT UNIQUE,                 -- sha256 van het token in de intakelink
  invite_expires TIMESTAMPTZ,
  invited_at     TIMESTAMPTZ,
  submitted_at   TIMESTAMPTZ,                 -- intake ingediend door de zzp'er
  released_at    TIMESTAMPTZ,                 -- vrijgegeven voor urenregistratie
  released_by    INT REFERENCES users(id),
  release_note   TEXT,                        -- motivering als er bewust van een waarschuwing is afgeweken
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_dossiers_user_idx ON onboarding_dossiers(user_id);

-- Documenten bij een dossier (pdf of foto), aangeleverd door de zzp'er via de intakelink of door de beheerder.
CREATE TABLE IF NOT EXISTS onboarding_files (
  id          SERIAL PRIMARY KEY,
  dossier_id  INT NOT NULL REFERENCES onboarding_dossiers(id) ON DELETE CASCADE,
  doc_key     TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INT NOT NULL,
  content     BYTEA NOT NULL,
  uploaded_by INT REFERENCES users(id),      -- NULL = de zzp'er via de intakelink
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_files_dossier_idx ON onboarding_files(dossier_id);

-- Interne notitie bij een uurregel (komt niet op de factuur)
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS internal_note TEXT;
