-- ============================================================
-- WellMinds / ICC — v2 Schema Additions
-- Run AFTER the baseline schema.sql. Idempotent (IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- A12/A13: RBAC expansion
-- ============================================================

CREATE TABLE IF NOT EXISTS permission_modules (
  key VARCHAR(100) PRIMARY KEY,
  scope VARCHAR(20) NOT NULL,
  label VARCHAR(255) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Seed company-scope modules
INSERT INTO permission_modules (key, scope, label, sort_order) VALUES
  ('home',                     'company', 'Home',                         10),
  ('profiles',                 'company', 'My Profile / Directory',       20),
  ('social_wall',              'company', 'Social Wall',                  30),
  ('smiles',                   'company', 'Smiles',                       40),
  ('events',                   'company', 'Events',                       50),
  ('surveys',                  'company', 'Surveys',                      60),
  ('wellbeing_indicators',     'company', 'Wellbeing Indicators',         70),
  ('wellbeing_resources',      'company', 'Wellbeing Resources',          80),
  ('professional_connect',     'company', 'Professional Connect',         90),
  ('eap',                      'company', 'EAP',                         100),
  ('challenges',               'company', 'Wellbeing Challenges',        110),
  ('learning_sessions',        'company', 'Learning Sessions',           120),
  ('performance_connect',      'company', 'Performance Connect',         130),
  ('development_connect',      'company', 'Development Connect',         140),
  ('wellbeing_connect',        'company', 'Wellbeing Connect',           150),
  ('hr_reports',               'company', 'HR Reports & Analytics',      200),
  ('settings_company',         'company', 'Company Settings',            210),
  ('settings_staff',           'company', 'Staff Management',            220),
  ('settings_rbac',            'company', 'Roles & Permissions',         230),
  ('settings_modules',         'company', 'Module Config',               240),
  ('settings_comms',           'company', 'Communication Templates',     250),
  ('settings_master_data',     'company', 'Master Records',              260),
  ('settings_connect_cycles',  'company', 'Connect Cycles',              270),
  ('icc_dashboard',            'icc',     'ICC Dashboard',                10),
  ('icc_clients',              'icc',     'Client Registrations & Orgs',  20),
  ('icc_indicators',           'icc',     'Indicator Builder',            30),
  ('icc_surveys',              'icc',     'Survey Builder',               40),
  ('icc_pulse_checks',         'icc',     'Pulse Checks (global)',        50),
  ('icc_resources',            'icc',     'Wellbeing Resources',          60),
  ('icc_sessions',             'icc',     'Learning Sessions',            70),
  ('icc_professionals',        'icc',     'Professionals Directory',      80),
  ('icc_challenges',           'icc',     'Challenges',                   90),
  ('icc_comms',                'icc',     'Communication Templates',     100),
  ('icc_analytics',            'icc',     'Analytics',                   110),
  ('icc_admin_users',          'icc',     'Admin Users & Roles',         120),
  ('icc_billing',              'icc',     'Billing / Subscriptions',     130)
ON CONFLICT (key) DO NOTHING;

-- ICC-side role tables
CREATE TABLE IF NOT EXISTS icc_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS icc_role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id UUID NOT NULL REFERENCES icc_roles(id) ON DELETE CASCADE,
  module VARCHAR(100) NOT NULL REFERENCES permission_modules(key),
  can_view BOOLEAN DEFAULT FALSE,
  can_add BOOLEAN DEFAULT FALSE,
  can_edit BOOLEAN DEFAULT FALSE,
  can_delete BOOLEAN DEFAULT FALSE,
  UNIQUE(role_id, module)
);

CREATE TABLE IF NOT EXISTS icc_admin_roles (
  admin_id UUID NOT NULL REFERENCES icc_admins(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES icc_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (admin_id, role_id)
);

INSERT INTO icc_roles (name, is_system) VALUES
  ('Super Admin', TRUE),
  ('Content Admin', TRUE),
  ('Support', TRUE)
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- A1: Indicator section ranges + report verbiage
-- ============================================================

CREATE TABLE IF NOT EXISTS indicator_section_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES indicator_sections(id) ON DELETE CASCADE,
  band_label VARCHAR(100) NOT NULL,
  score_min INTEGER NOT NULL,
  score_max INTEGER NOT NULL,
  short_description TEXT,
  report_verbiage_html TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (score_max >= score_min)
);
CREATE INDEX IF NOT EXISTS idx_indicator_section_ranges_section ON indicator_section_ranges(section_id);

CREATE TABLE IF NOT EXISTS indicator_overall_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  band_label VARCHAR(100) NOT NULL,
  score_min INTEGER NOT NULL,
  score_max INTEGER NOT NULL,
  conclusion_html TEXT NOT NULL,
  recommendation_resource_ids UUID[],
  sort_order INTEGER DEFAULT 0
);

-- ============================================================
-- A2: Pulse checks (ICC-global + company-authored)
-- ============================================================

CREATE TABLE IF NOT EXISTS pulse_checks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  scope VARCHAR(20) NOT NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  created_by_icc UUID REFERENCES icc_admins(id),
  created_by_user UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'draft',
  frequency VARCHAR(20) DEFAULT 'continuous',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (scope IN ('icc_global','company'))
);

CREATE TABLE IF NOT EXISTS pulse_check_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pulse_check_id UUID NOT NULL REFERENCES pulse_checks(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  metric_key VARCHAR(100) NOT NULL,
  scale_min INTEGER DEFAULT 1,
  scale_max INTEGER DEFAULT 10,
  sort_order INTEGER DEFAULT 0
);

ALTER TABLE wellbeing_checks
  ADD COLUMN IF NOT EXISTS pulse_check_id UUID REFERENCES pulse_checks(id) ON DELETE SET NULL;

-- ============================================================
-- A3: Company subdomain
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_companies_subdomain ON companies(subdomain);

-- ============================================================
-- A4: Subscription tiers + renewal tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_tiers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  min_employees INTEGER NOT NULL,
  max_employees INTEGER, -- NULL = unbounded
  monthly_price_usd NUMERIC(10,2),
  annual_price_usd NUMERIC(10,2),
  is_bespoke BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO subscription_tiers (name, min_employees, max_employees, monthly_price_usd, annual_price_usd, sort_order) VALUES
  ('Starter',      0,    10,   99,    999,   10),
  ('Small',       11,    20,  199,   1999,   20),
  ('Growth',      21,    50,  399,   3999,   30),
  ('Team',        51,   100,  699,   6999,   40),
  ('Business',   101,   250, 1299,  12999,   50),
  ('Scale',      251,   500, 2499,  24999,   60),
  ('Enterprise', 501,  1000, 4499,  44999,   70)
ON CONFLICT (name) DO NOTHING;
INSERT INTO subscription_tiers (name, min_employees, max_employees, is_bespoke, sort_order)
  VALUES ('Bespoke 1000+', 1001, NULL, TRUE, 80)
  ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS company_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tier_id UUID NOT NULL REFERENCES subscription_tiers(id),
  start_date DATE NOT NULL,
  renewal_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active | expired | cancelled | renewal_pending
  approved_by_icc UUID REFERENCES icc_admins(id),
  approved_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company ON company_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_renewal ON company_subscriptions(renewal_date, status);

-- ============================================================
-- A5: Social Wall audience targeting + compliance
-- ============================================================

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS audience_type VARCHAR(20) DEFAULT 'org',
  ADD COLUMN IF NOT EXISTS audience_value JSONB,
  ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS compliance_acknowledged BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS parent_post_id UUID REFERENCES posts(id) ON DELETE CASCADE;

ALTER TABLE post_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id UUID REFERENCES post_comments(id) ON DELETE CASCADE;

-- ============================================================
-- A6: EAP content pages
-- ============================================================

CREATE TABLE IF NOT EXISTS eap_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
  banner_url TEXT,
  banner_heading VARCHAR(255),
  banner_subheading TEXT,
  intro_html TEXT,
  contact_phone VARCHAR(50),
  contact_email VARCHAR(255),
  contact_website TEXT,
  hours_text VARCHAR(255),
  custom_html TEXT,
  is_published BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eap_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  eap_page_id UUID NOT NULL REFERENCES eap_pages(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100),
  booking_url TEXT,
  sort_order INTEGER DEFAULT 0
);

-- ============================================================
-- A7: Resource impact reflections (21-day nudge)
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_impact_reflections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  used_it BOOLEAN,
  notes TEXT,
  linked_wellbeing_objective_id UUID REFERENCES wellbeing_objectives(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- A8: Smile categories ↔ culture behaviour statements
-- ============================================================

ALTER TABLE smile_categories
  ADD COLUMN IF NOT EXISTS behaviour_statement TEXT,
  ADD COLUMN IF NOT EXISTS culture_doc_source_id UUID;

-- ============================================================
-- A9/A10: Connect Cycle submission window + objective approval
-- ============================================================

ALTER TABLE connect_cycles
  ADD COLUMN IF NOT EXISTS objective_window_days INTEGER DEFAULT 14,
  ADD COLUMN IF NOT EXISTS allow_late_add_after_close BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS cycle_reflection_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id UUID NOT NULL REFERENCES connect_cycles(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(cycle_id, label)
);

ALTER TABLE performance_objectives
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS manager_note TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cascaded_from_objective_id UUID REFERENCES performance_objectives(id);

ALTER TABLE development_objectives
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS manager_note TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cascaded_from_objective_id UUID REFERENCES development_objectives(id);

ALTER TABLE wellbeing_objectives
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS manager_note TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cascaded_from_objective_id UUID REFERENCES wellbeing_objectives(id),
  ADD COLUMN IF NOT EXISTS share_with_manager BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS objective_visibility_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_type VARCHAR(20) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reflection_signoffs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_type VARCHAR(20) NOT NULL,
  reflection_id UUID NOT NULL,
  role VARCHAR(50) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address INET,
  note TEXT,
  revoked_at TIMESTAMPTZ
);

-- ============================================================
-- A11: Communication templates (unified email/notif/whatsapp/nudge)
-- ============================================================

CREATE TABLE IF NOT EXISTS communication_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scope VARCHAR(20) NOT NULL, -- 'icc_global' | 'company'
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  trigger_key VARCHAR(100) NOT NULL,      -- e.g. 'user.invite', 'indicator.completed'
  channel VARCHAR(20) NOT NULL,           -- 'email' | 'in_app' | 'whatsapp' | 'nudge'
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  body_html TEXT,
  body_text TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  variables JSONB,                        -- allowed placeholder list
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scope, company_id, trigger_key, channel)
);
CREATE INDEX IF NOT EXISTS idx_comm_templates_trigger ON communication_templates(trigger_key, channel);

CREATE TABLE IF NOT EXISTS communication_template_company_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_template_id UUID NOT NULL REFERENCES communication_templates(id) ON DELETE CASCADE,
  subject VARCHAR(500),
  body_html TEXT,
  body_text TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, parent_template_id)
);

-- ============================================================
-- A14: Certification renewal alerts
-- ============================================================

CREATE TABLE IF NOT EXISTS certification_renewal_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  certification_id UUID NOT NULL REFERENCES employee_certifications(id) ON DELETE CASCADE,
  fire_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  channel VARCHAR(20) DEFAULT 'email',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cert_alerts_fire ON certification_renewal_alerts(fire_at, sent_at);

-- ============================================================
-- A15: Client self-registration enhancements
-- ============================================================

ALTER TABLE client_registrations
  ADD COLUMN IF NOT EXISTS intake_token VARCHAR(100) UNIQUE,
  ADD COLUMN IF NOT EXISTS intake_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intake_source VARCHAR(50) DEFAULT 'public_link',
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tier_id UUID REFERENCES subscription_tiers(id);

-- ============================================================
-- A16: Growth snapshot view (employee connect progress)
-- ============================================================

CREATE OR REPLACE VIEW v_user_growth_snapshot AS
SELECT
  u.id AS user_id,
  u.company_id,
  COALESCE(perf.pct_complete, 0) AS performance_pct,
  COALESCE(dev.pct_complete, 0)  AS development_pct,
  COALESCE(wb.pct_complete, 0)   AS wellbeing_pct,
  COALESCE(perf.final_rating, '-') AS performance_rating,
  COALESCE(dev.final_rating, '-')  AS development_rating,
  COALESCE(wb.final_rating, '-')   AS wellbeing_rating,
  GREATEST(perf.updated_at, dev.updated_at, wb.updated_at) AS last_activity
FROM users u
LEFT JOIN LATERAL (
  SELECT
    CASE
      WHEN COUNT(*) FILTER (WHERE employee_signed_off AND manager_signed_off) > 0 THEN 100
      WHEN COUNT(*) FILTER (WHERE is_consolidated) > 0 THEN 80
      WHEN COUNT(*) FILTER (WHERE manager_submitted_at IS NOT NULL) > 0 THEN 60
      WHEN COUNT(*) FILTER (WHERE submitted_at IS NOT NULL) > 0 THEN 40
      WHEN COUNT(*) > 0 THEN 20
      ELSE 0
    END AS pct_complete,
    (SELECT r.label FROM rating_scales r
       WHERE r.id = ANY(ARRAY_AGG(pr.final_agreed_rating_id))
       LIMIT 1) AS final_rating,
    MAX(pr.updated_at) AS updated_at
  FROM performance_reflections pr
  WHERE pr.user_id = u.id
) perf ON TRUE
LEFT JOIN LATERAL (
  SELECT
    CASE
      WHEN COUNT(*) FILTER (WHERE employee_signed_off AND manager_signed_off) > 0 THEN 100
      WHEN COUNT(*) > 0 THEN 40
      ELSE 0
    END AS pct_complete,
    '-' AS final_rating,
    MAX(dr.updated_at) AS updated_at
  FROM development_reflections dr
  WHERE dr.user_id = u.id
) dev ON TRUE
LEFT JOIN LATERAL (
  SELECT
    CASE
      WHEN COUNT(*) FILTER (WHERE employee_signed_off AND manager_signed_off) > 0 THEN 100
      WHEN COUNT(*) > 0 THEN 40
      ELSE 0
    END AS pct_complete,
    '-' AS final_rating,
    MAX(wr.updated_at) AS updated_at
  FROM wellbeing_reflections wr
  WHERE wr.user_id = u.id
) wb ON TRUE;

-- ============================================================
-- Wellbeing resources library (new — v2 standalone)
-- indicator overall bands reference these via recommendation_resource_ids.
-- kept separate from v1 `resources` (milestone-bound) so ICC content admins
-- can publish standalone resources for indicator/EAP surfaces.
-- ============================================================
CREATE TABLE IF NOT EXISTS wellbeing_resources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(500) NOT NULL,
  description   TEXT,
  resource_url  TEXT,
  category      VARCHAR(100),
  format        VARCHAR(50),         -- article | video | audio | pdf | link | interactive
  duration_min  INTEGER,
  is_active     BOOLEAN DEFAULT TRUE,
  created_by    UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wellbeing_resources_active    ON wellbeing_resources(is_active);
CREATE INDEX IF NOT EXISTS idx_wellbeing_resources_category  ON wellbeing_resources(category);

-- Starter rows — idempotent
INSERT INTO wellbeing_resources (title, description, category, format, duration_min)
SELECT * FROM (VALUES
  ('5-minute breathing reset',             'Guided reset you can run between meetings.',       'stress',     'audio',    5),
  ('Weekly recovery checklist',            'Print-friendly checklist for sustained recovery.', 'recovery',   'pdf',      NULL::int),
  ('Boundaries playbook',                  'How to communicate boundaries without friction.',  'boundaries', 'article',  7),
  ('Manager 1:1 script — workload',        'Script for raising workload concerns kindly.',     'management', 'pdf',      NULL::int),
  ('Recovery conversation guide',          'Frame recovery needs with your manager.',          'recovery',   'article',  9),
  ('Sleep & stress — a 10-min explainer',  'Relationship between recovery and burnout signal.','sleep',      'video',   10),
  ('Contact EAP (confidential)',           'Reach InterBeing Care EAP 24/7.',                  'eap',        'link',     NULL::int),
  ('3-week recovery plan',                 'Structured plan to cool burnout signals.',         'recovery',   'pdf',      NULL::int)
) AS v(title, description, category, format, duration_min)
WHERE NOT EXISTS (SELECT 1 FROM wellbeing_resources LIMIT 1);

-- ============================================================
-- Seed: ICC-global pulse check (5 standard metrics)
-- ============================================================

DO $$
DECLARE
  v_admin_id UUID;
  v_pulse_id UUID := '11111111-1111-1111-1111-111111111111'::uuid;
BEGIN
  SELECT id INTO v_admin_id FROM icc_admins ORDER BY created_at LIMIT 1;
  IF v_admin_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pulse_checks WHERE id = v_pulse_id) THEN
    INSERT INTO pulse_checks (id, title, scope, created_by_icc, status, frequency)
      VALUES (v_pulse_id, 'ICC Global Pulse', 'icc_global', v_admin_id, 'active', 'continuous');
    INSERT INTO pulse_check_questions (pulse_check_id, question_text, metric_key, sort_order) VALUES
      (v_pulse_id, 'Overall wellbeing today?',  'overall',    10),
      (v_pulse_id, 'Energy level?',             'energy',     20),
      (v_pulse_id, 'Stress level?',             'stress',     30),
      (v_pulse_id, 'Sense of connection?',      'connection', 40),
      (v_pulse_id, 'Sense of purpose?',         'purpose',    50);
  END IF;
END $$;

-- ============================================================
-- Done. Count additions (for visual confirmation on run):
-- ============================================================

DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM permission_modules;
  RAISE NOTICE 'v2 migration applied. permission_modules seeded: %', v_count;
  SELECT COUNT(*) INTO v_count FROM subscription_tiers;
  RAISE NOTICE 'subscription_tiers seeded: %', v_count;
END $$;
