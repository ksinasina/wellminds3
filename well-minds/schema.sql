-- ============================================================
-- InterBeing Care Connect (ICC) Platform
-- Complete PostgreSQL Schema
-- Version 2.0 - Production-Ready
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- LEVEL 1: ICC ADMIN (Platform Super-Admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS icc_admins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  role VARCHAR(50) DEFAULT 'support', -- super_admin | content_admin | support
  status VARCHAR(50) DEFAULT 'active', -- active | inactive | suspended
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icc_admins_email ON icc_admins(email);
CREATE INDEX IF NOT EXISTS idx_icc_admins_role ON icc_admins(role);

-- ============================================================
-- ICC REFRESH TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS icc_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES icc_admins(id) ON DELETE CASCADE,
  token VARCHAR(512) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icc_refresh_tokens_admin ON icc_refresh_tokens(admin_id);

-- ============================================================
-- LEVEL 2: ORGANIZATION TABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  company_code VARCHAR(50) UNIQUE,
  phone VARCHAR(50),
  website TEXT,
  description TEXT,
  logo_url TEXT,
  banner_url TEXT,
  signin_logo_url TEXT,
  brand_name VARCHAR(255),
  powered_by_text VARCHAR(255) DEFAULT 'Powered by Interbeing Leadership',
  primary_color VARCHAR(20) DEFAULT '#1a8784',
  plan VARCHAR(50) DEFAULT 'free', -- free | pro | enterprise
  max_users INTEGER DEFAULT 50,
  show_new_joiners BOOLEAN DEFAULT TRUE,
  eap_enabled BOOLEAN DEFAULT FALSE,
  eap_url TEXT,
  professionals_enabled BOOLEAN DEFAULT FALSE,
  challenges_enabled BOOLEAN DEFAULT FALSE,
  theme_config JSONB,
  -- Address fields
  address_line1 TEXT,
  address_line2 TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  postal_code VARCHAR(50),
  timezone VARCHAR(100) DEFAULT 'UTC',
  employee_strength VARCHAR(50), -- '1-10','11-50','51-100','101-250','250+'
  -- SSL / SMTP
  ssl_enabled BOOLEAN DEFAULT TRUE,
  smtp_host VARCHAR(255),
  smtp_port INTEGER,
  smtp_user VARCHAR(255),
  smtp_pass VARCHAR(255),
  smtp_from_email VARCHAR(255),
  smtp_from_name VARCHAR(255),
  smtp_provider VARCHAR(100),
  smtp_business_email VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_code ON companies(company_code);

-- ============================================================
-- DEPARTMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  business_unit VARCHAR(200),
  parent_department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  head_of_department_id UUID, -- FK added after users table
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_departments_company ON departments(company_id);
CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_department_id);
CREATE INDEX IF NOT EXISTS idx_departments_head ON departments(head_of_department_id);

-- ============================================================
-- JOB LEVELS
-- ============================================================
CREATE TABLE IF NOT EXISTS job_levels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  grade VARCHAR(50),
  sort_order INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'active', -- active | inactive
  framework VARCHAR(100), -- 'paterson'|'peromnes'|'hay'|'custom'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_levels_company ON job_levels(company_id);
CREATE INDEX IF NOT EXISTS idx_job_levels_status ON job_levels(status);

-- ============================================================
-- BUSINESS UNITS
-- ============================================================
CREATE TABLE IF NOT EXISTS business_units (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  head_id UUID, -- FK added after users table
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_units_company ON business_units(company_id);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  display_name VARCHAR(200),
  avatar_url TEXT,
  employee_code VARCHAR(100),
  job_title VARCHAR(200),
  department VARCHAR(200),
  business_unit VARCHAR(200),
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  functional_manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  job_level VARCHAR(100),
  job_grade VARCHAR(50),
  job_level_id UUID REFERENCES job_levels(id) ON DELETE SET NULL,
  primary_business_unit_id UUID REFERENCES business_units(id) ON DELETE SET NULL,
  employee_number VARCHAR(100),
  date_of_birth DATE,
  gender VARCHAR(50),
  nationality VARCHAR(100),
  marital_status VARCHAR(50),
  tax_number VARCHAR(100),
  phone VARCHAR(50),
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  postal_code VARCHAR(50),
  start_date DATE,
  -- Emergency contact
  emergency_contact_name VARCHAR(200),
  emergency_contact_phone VARCHAR(50),
  emergency_contact_relationship VARCHAR(100),
  -- Profile
  hobbies TEXT,
  profile_visibility VARCHAR(50) DEFAULT 'limited', -- limited | full | private
  bio TEXT,
  is_new_joiner BOOLEAN DEFAULT TRUE,
  new_joiner_until DATE,
  role VARCHAR(50) DEFAULT 'staff', -- admin | manager | staff
  status VARCHAR(50) DEFAULT 'invited', -- invited | active | inactive | suspended
  last_login_at TIMESTAMPTZ,
  invite_token VARCHAR(255),
  invite_expires_at TIMESTAMPTZ,
  reset_token VARCHAR(255),
  reset_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS idx_users_functional_manager ON users(functional_manager_id);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_job_level_id ON users(job_level_id);
CREATE INDEX IF NOT EXISTS idx_users_primary_bu ON users(primary_business_unit_id);
CREATE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code);

-- Add deferred FK constraints
ALTER TABLE departments
  ADD CONSTRAINT fk_departments_head
  FOREIGN KEY (head_of_department_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE business_units
  ADD CONSTRAINT fk_business_units_head
  FOREIGN KEY (head_id) REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================
-- USER BUSINESS UNITS (many-to-many)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_business_units (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_unit_id UUID NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, business_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_user_business_units_user ON user_business_units(user_id);
CREATE INDEX IF NOT EXISTS idx_user_business_units_bu ON user_business_units(business_unit_id);

-- ============================================================
-- USER DEPARTMENTS (many-to-many)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_departments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_user_departments_user ON user_departments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_departments_dept ON user_departments(department_id);

-- ============================================================
-- ROLES (custom roles per company)
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_roles_company ON roles(company_id);

-- ============================================================
-- ROLE PERMISSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module VARCHAR(100) NOT NULL, -- email_template|staff_management|company_management|reports|business_unit_management|department_management|survey_management|event_management
  can_view BOOLEAN DEFAULT FALSE,
  can_add BOOLEAN DEFAULT FALSE,
  can_edit BOOLEAN DEFAULT FALSE,
  can_delete BOOLEAN DEFAULT FALSE,
  CHECK (module IN ('email_template','staff_management','company_management','reports','business_unit_management','department_management','survey_management','event_management'))
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

-- ============================================================
-- USER ROLES
-- ============================================================
CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_assigned_by ON user_roles(assigned_by);

-- ============================================================
-- REFRESH TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(512) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================
-- MODULE SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS module_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_name VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN DEFAULT FALSE,
  activated_at TIMESTAMPTZ,
  UNIQUE(company_id, module_name),
  CHECK (module_name IN ('profiles','social_wall','events','performance_connect','development_connect','wellbeing_connect','wellbeing_indicators','recognition','surveys','challenges','professional_connect','learning_sessions'))
);

CREATE INDEX IF NOT EXISTS idx_module_subscriptions_company ON module_subscriptions(company_id);

-- ============================================================
-- CLIENT REGISTRATIONS (IBL admin registration workflow)
-- ============================================================
CREATE TABLE IF NOT EXISTS client_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  company_name VARCHAR(255) NOT NULL,
  street_address TEXT,
  country VARCHAR(100),
  state_province VARCHAR(100),
  city VARCHAR(100),
  postal_code VARCHAR(50),
  timezone VARCHAR(100),
  employee_strength VARCHAR(50),
  selected_modules JSONB, -- array of module names
  status VARCHAR(50) DEFAULT 'pending', -- pending | approved | rejected
  rejection_reason TEXT,
  approved_by UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL, -- set after approval
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_registrations_status ON client_registrations(status);
CREATE INDEX IF NOT EXISTS idx_client_registrations_email ON client_registrations(email);
CREATE INDEX IF NOT EXISTS idx_client_registrations_approved_by ON client_registrations(approved_by);
CREATE INDEX IF NOT EXISTS idx_client_registrations_company ON client_registrations(company_id);

-- ============================================================
-- CONNECT CONFIGURATIONS (per company, weighted progress)
-- ============================================================
CREATE TABLE IF NOT EXISTS connect_configurations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_type VARCHAR(50) NOT NULL, -- performance | development | wellbeing
  performance_consolidation BOOLEAN DEFAULT TRUE,
  reflection_type VARCHAR(50) DEFAULT 'single', -- single | multiple
  objective_creation_weight DECIMAL(5,2) DEFAULT 0,
  objective_approval_weight DECIMAL(5,2) DEFAULT 0,
  self_reflection_weight DECIMAL(5,2) DEFAULT 0,
  manager_reflection_weight DECIMAL(5,2) DEFAULT 0,
  self_signoff_weight DECIMAL(5,2) DEFAULT 0,
  manager_signoff_weight DECIMAL(5,2) DEFAULT 0,
  objective_submission_deadline DATE,
  reflection_due_dates JSONB, -- array of {period, due_date}
  hard_cutoff BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, module_type),
  CHECK (module_type IN ('performance','development','wellbeing'))
);

CREATE INDEX IF NOT EXISTS idx_connect_configurations_company ON connect_configurations(company_id);

-- ============================================================
-- NEW JOINER VISIBILITY SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS new_joiner_visibility_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
  show_new_joiners BOOLEAN DEFAULT TRUE,
  visibility_scope VARCHAR(50) DEFAULT 'all', -- all | selected_groups | none
  visibility_groups JSONB, -- department/BU/role IDs
  new_joiner_duration_days INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MASTER RECORDS: SMILE CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS smile_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100),
  color VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smile_categories_company ON smile_categories(company_id);

-- ============================================================
-- MASTER RECORDS: OBJECTIVE CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS objective_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  module_type VARCHAR(50) NOT NULL, -- performance | development | wellbeing
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objective_categories_company ON objective_categories(company_id);
CREATE INDEX IF NOT EXISTS idx_objective_categories_module ON objective_categories(module_type);

-- ============================================================
-- MASTER RECORDS: OBJECTIVE TEMPLATES
-- ============================================================
CREATE TABLE IF NOT EXISTS objective_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id UUID REFERENCES objective_categories(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  department VARCHAR(255),
  module_type VARCHAR(50) NOT NULL, -- performance | development | wellbeing
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objective_templates_company ON objective_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_objective_templates_category ON objective_templates(category_id);
CREATE INDEX IF NOT EXISTS idx_objective_templates_module ON objective_templates(module_type);

-- ============================================================
-- MASTER RECORDS: OBJECTIVE STATUSES
-- ============================================================
CREATE TABLE IF NOT EXISTS objective_statuses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20),
  is_default BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  module_type VARCHAR(50) NOT NULL, -- performance | development | wellbeing
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objective_statuses_company ON objective_statuses(company_id);
CREATE INDEX IF NOT EXISTS idx_objective_statuses_module ON objective_statuses(module_type);

-- ============================================================
-- MASTER RECORDS: RATING SCALES
-- ============================================================
CREATE TABLE IF NOT EXISTS rating_scales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  numeric_value INTEGER NOT NULL,
  color VARCHAR(20),
  module_type VARCHAR(50) NOT NULL, -- performance | development
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rating_scales_company ON rating_scales(company_id);
CREATE INDEX IF NOT EXISTS idx_rating_scales_module ON rating_scales(module_type);

-- ============================================================
-- MASTER RECORDS: CONNECT CYCLES
-- ============================================================
CREATE TABLE IF NOT EXISTS connect_cycles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  module_type VARCHAR(50) NOT NULL, -- performance | development | wellbeing
  frequency VARCHAR(50) NOT NULL, -- monthly | quarterly | biannual | annual
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reflection_mode VARCHAR(50) DEFAULT 'one_per_objective', -- one_per_objective | one_for_all
  status VARCHAR(50) DEFAULT 'upcoming', -- upcoming | active | closed
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_cycles_company ON connect_cycles(company_id);
CREATE INDEX IF NOT EXISTS idx_connect_cycles_module ON connect_cycles(module_type);
CREATE INDEX IF NOT EXISTS idx_connect_cycles_status ON connect_cycles(status);

-- ============================================================
-- MASTER RECORDS: CONNECT CYCLE ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS connect_cycle_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id UUID NOT NULL REFERENCES connect_cycles(id) ON DELETE CASCADE,
  assignment_type VARCHAR(50) NOT NULL, -- all | department | business_unit | user
  assignment_value VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cycle_assignments_cycle ON connect_cycle_assignments(cycle_id);
CREATE INDEX IF NOT EXISTS idx_cycle_assignments_type ON connect_cycle_assignments(assignment_type);

-- ============================================================
-- MASTER RECORDS: DOCUMENT TYPES
-- ============================================================
CREATE TABLE IF NOT EXISTS document_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_required BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_types_company ON document_types(company_id);

-- ============================================================
-- MASTER RECORDS: TRAINING TYPES
-- ============================================================
CREATE TABLE IF NOT EXISTS training_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_types_company ON training_types(company_id);

-- ============================================================
-- MASTER RECORDS: CERTIFICATION TYPES
-- ============================================================
CREATE TABLE IF NOT EXISTS certification_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_certification_types_company ON certification_types(company_id);

-- ============================================================
-- MASTER RECORDS: CUSTOM HRIS FIELDS
-- ============================================================
CREATE TABLE IF NOT EXISTS custom_hris_fields (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_name VARCHAR(255) NOT NULL,
  field_label VARCHAR(255) NOT NULL,
  field_type VARCHAR(50) NOT NULL, -- text | number | date | select | boolean | textarea
  options JSONB,
  is_required BOOLEAN DEFAULT FALSE,
  section VARCHAR(100), -- Personal | Employment | Custom
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_hris_fields_company ON custom_hris_fields(company_id);

-- ============================================================
-- HRIS / PROFILE MODULE
-- ============================================================
CREATE TABLE IF NOT EXISTS employee_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type_id UUID NOT NULL REFERENCES document_types(id) ON DELETE RESTRICT,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  notes TEXT,
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_employee_documents_user ON employee_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_company ON employee_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_type ON employee_documents(document_type_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_verified ON employee_documents(verified_by);

-- ============================================================
-- EMPLOYEE TRAINING
-- ============================================================
CREATE TABLE IF NOT EXISTS employee_training (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  training_type_id UUID NOT NULL REFERENCES training_types(id) ON DELETE RESTRICT,
  training_name VARCHAR(500) NOT NULL,
  institute VARCHAR(255),
  start_date DATE,
  end_date DATE,
  cost DECIMAL(10,2),
  currency VARCHAR(10),
  proof_url TEXT,
  proof_file_name VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_training_user ON employee_training(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_training_company ON employee_training(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_training_type ON employee_training(training_type_id);

-- ============================================================
-- EMPLOYEE CERTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS employee_certifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  certification_type_id UUID NOT NULL REFERENCES certification_types(id) ON DELETE RESTRICT,
  certification_name VARCHAR(500) NOT NULL,
  issuing_body VARCHAR(255),
  issue_date DATE,
  expiry_date DATE,
  license_number VARCHAR(100),
  proof_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_certifications_user ON employee_certifications(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_certifications_company ON employee_certifications(company_id);
CREATE INDEX IF NOT EXISTS idx_employee_certifications_type ON employee_certifications(certification_type_id);

-- ============================================================
-- CUSTOM FIELD VALUES
-- ============================================================
CREATE TABLE IF NOT EXISTS custom_field_values (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES custom_hris_fields(id) ON DELETE CASCADE,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_field_values_user ON custom_field_values(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_company ON custom_field_values(company_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_field ON custom_field_values(field_id);

-- ============================================================
-- EMPLOYMENT HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS employment_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employer_name VARCHAR(255) NOT NULL,
  job_title VARCHAR(255),
  start_date DATE,
  end_date DATE,
  description TEXT,
  is_current BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employment_history_user ON employment_history(user_id);
CREATE INDEX IF NOT EXISTS idx_employment_history_company ON employment_history(company_id);

-- ============================================================
-- WELLBEING INDICATORS (Assessments) - MASTER RECORDS
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(100),
  color VARCHAR(20),
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_indicator_categories_name ON indicator_categories(name);

-- ============================================================
-- INDICATORS (Assessments)
-- ============================================================
CREATE TABLE IF NOT EXISTS indicators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by_icc UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  category_id UUID NOT NULL REFERENCES indicator_categories(id) ON DELETE RESTRICT,
  introduction_html TEXT,
  conclusion_html TEXT,
  disclaimer TEXT,
  footer_html TEXT,
  mail_content_html TEXT,
  banner_url TEXT,
  background_url TEXT,
  include_scoring BOOLEAN DEFAULT TRUE,
  admin_distribution_only BOOLEAN DEFAULT FALSE,
  send_results BOOLEAN DEFAULT TRUE,
  status VARCHAR(50) DEFAULT 'draft', -- draft | published | archived
  is_timed BOOLEAN DEFAULT FALSE,
  available_from TIMESTAMPTZ,
  available_until TIMESTAMPTZ,
  allow_retake BOOLEAN DEFAULT TRUE,
  max_retakes INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_indicators_category ON indicators(category_id);
CREATE INDEX IF NOT EXISTS idx_indicators_status ON indicators(status);
CREATE INDEX IF NOT EXISTS idx_indicators_created_by ON indicators(created_by_icc);

-- ============================================================
-- INDICATOR SECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_sections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  score_min INTEGER,
  score_max INTEGER,
  scoring_enabled BOOLEAN DEFAULT TRUE,
  multiplier DECIMAL(5,2) DEFAULT 1.0,
  base_max_score INTEGER,
  effective_max_score INTEGER
);

CREATE INDEX IF NOT EXISTS idx_indicator_sections_indicator ON indicator_sections(indicator_id);

-- ============================================================
-- INDICATOR QUESTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES indicator_sections(id) ON DELETE CASCADE,
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_type VARCHAR(50) NOT NULL, -- rating | scale | multiple_choice | yes_no
  options JSONB,
  score_weight DECIMAL(3,2) DEFAULT 1.0,
  scoring_enabled BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_indicator_questions_section ON indicator_questions(section_id);
CREATE INDEX IF NOT EXISTS idx_indicator_questions_indicator ON indicator_questions(indicator_id);

-- ============================================================
-- INDICATOR RESPONSES (Curated responses for each score scenario)
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  section_id UUID REFERENCES indicator_sections(id) ON DELETE SET NULL,
  score_range_min INTEGER NOT NULL,
  score_range_max INTEGER NOT NULL,
  response_html TEXT NOT NULL,
  severity VARCHAR(50), -- low | moderate | high | critical
  recommendations TEXT
);

CREATE INDEX IF NOT EXISTS idx_indicator_responses_indicator ON indicator_responses(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_responses_section ON indicator_responses(section_id);

-- ============================================================
-- INDICATOR ORG ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_org_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by UUID NOT NULL REFERENCES icc_admins(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_indicator_org_assignments_indicator ON indicator_org_assignments(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_org_assignments_company ON indicator_org_assignments(company_id);

-- ============================================================
-- INDICATOR SCHEDULES
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE, -- null = all assigned orgs
  start_datetime TIMESTAMPTZ,
  end_datetime TIMESTAMPTZ,
  recurrence VARCHAR(50), -- none | weekly | monthly | quarterly | annually
  timezone VARCHAR(100),
  max_attempts INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_indicator_schedules_indicator ON indicator_schedules(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_schedules_company ON indicator_schedules(company_id);

-- ============================================================
-- INDICATOR COMPLETIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_completions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE RESTRICT,
  total_score INTEGER,
  section_scores JSONB,
  report_html TEXT,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  report_emailed BOOLEAN DEFAULT FALSE,
  report_emailed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_indicator_completions_user ON indicator_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_indicator_completions_company ON indicator_completions(company_id);
CREATE INDEX IF NOT EXISTS idx_indicator_completions_indicator ON indicator_completions(indicator_id);
CREATE INDEX IF NOT EXISTS idx_indicator_completions_completed_at ON indicator_completions(completed_at);

-- ============================================================
-- INDICATOR ANSWERS
-- ============================================================
CREATE TABLE IF NOT EXISTS indicator_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  completion_id UUID NOT NULL REFERENCES indicator_completions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES indicator_questions(id) ON DELETE RESTRICT,
  answer_value TEXT,
  score INTEGER
);

CREATE INDEX IF NOT EXISTS idx_indicator_answers_completion ON indicator_answers(completion_id);
CREATE INDEX IF NOT EXISTS idx_indicator_answers_question ON indicator_answers(question_id);

-- ============================================================
-- WELLBEING RESOURCES (Udemy-style with Milestones)
-- ============================================================
CREATE TABLE IF NOT EXISTS resource_themes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by_icc UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL, -- mental | social | physical | financial
  thumbnail_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_themes_category ON resource_themes(category);
CREATE INDEX IF NOT EXISTS idx_resource_themes_created_by ON resource_themes(created_by_icc);

-- ============================================================
-- RESOURCE MILESTONES
-- ============================================================
CREATE TABLE IF NOT EXISTS resource_milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  theme_id UUID NOT NULL REFERENCES resource_themes(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_milestones_theme ON resource_milestones(theme_id);

-- ============================================================
-- RESOURCES
-- ============================================================
CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  milestone_id UUID NOT NULL REFERENCES resource_milestones(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  resource_type VARCHAR(50) NOT NULL, -- article | video | audio | pdf | link | interactive
  content_url TEXT,
  content_html TEXT,
  thumbnail_url TEXT,
  duration_minutes INTEGER,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_milestone ON resources(milestone_id);
CREATE INDEX IF NOT EXISTS idx_resources_active ON resources(is_active);

-- ============================================================
-- RESOURCE ORG ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS resource_org_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  theme_id UUID NOT NULL REFERENCES resource_themes(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_org_assignments_theme ON resource_org_assignments(theme_id);
CREATE INDEX IF NOT EXISTS idx_resource_org_assignments_company ON resource_org_assignments(company_id);

-- ============================================================
-- RESOURCE PROGRESS
-- ============================================================
CREATE TABLE IF NOT EXISTS resource_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  milestone_id UUID NOT NULL REFERENCES resource_milestones(id) ON DELETE CASCADE,
  theme_id UUID NOT NULL REFERENCES resource_themes(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'not_started', -- not_started | in_progress | completed
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  UNIQUE(user_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_progress_user ON resource_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_resource_progress_resource ON resource_progress(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_progress_company ON resource_progress(company_id);
CREATE INDEX IF NOT EXISTS idx_resource_progress_status ON resource_progress(status);

-- ============================================================
-- PROFESSIONALS / EAP
-- ============================================================
CREATE TABLE IF NOT EXISTS professionals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by_icc UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  title VARCHAR(255),
  specialization VARCHAR(255),
  bio TEXT,
  photo_url TEXT,
  email VARCHAR(255),
  phone VARCHAR(50),
  booking_url TEXT,
  professional_type VARCHAR(50) NOT NULL, -- coach | therapist | psychologist | counselor | other
  credentials TEXT,
  licence_number VARCHAR(100),
  country_of_registration VARCHAR(100),
  languages JSONB, -- array of languages
  modalities JSONB, -- ['video','phone','in_person']
  availability_model VARCHAR(50), -- 'fixed'|'flexible'
  intro_video_url TEXT,
  external_links JSONB,
  account_status VARCHAR(50) DEFAULT 'invited', -- invited | active | suspended
  is_preferred_provider BOOLEAN DEFAULT FALSE,
  password_hash VARCHAR(255),
  invite_token VARCHAR(255),
  invite_expires_at TIMESTAMPTZ,
  terms_accepted_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_professionals_company ON professionals(company_id);
CREATE INDEX IF NOT EXISTS idx_professionals_type ON professionals(professional_type);
CREATE INDEX IF NOT EXISTS idx_professionals_active ON professionals(is_active);
CREATE INDEX IF NOT EXISTS idx_professionals_account_status ON professionals(account_status);

-- ============================================================
-- PROFESSIONAL CREDENTIALS
-- ============================================================
CREATE TABLE IF NOT EXISTS professional_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  credential_type VARCHAR(100),
  credential_name VARCHAR(255),
  issuing_body VARCHAR(255),
  issue_date DATE,
  expiry_date DATE,
  license_number VARCHAR(100),
  country VARCHAR(100),
  document_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_professional_credentials_prof ON professional_credentials(professional_id);

-- ============================================================
-- PROFESSIONAL AVAILABILITY
-- ============================================================
CREATE TABLE IF NOT EXISTS professional_availability (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_available BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_professional_availability_prof ON professional_availability(professional_id);

-- ============================================================
-- PROFESSIONAL ORG ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS professional_org_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(professional_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_professional_org_assignments_professional ON professional_org_assignments(professional_id);
CREATE INDEX IF NOT EXISTS idx_professional_org_assignments_company ON professional_org_assignments(company_id);

-- ============================================================
-- ORGANIZATION PROFESSIONAL ENTITLEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS organization_professional_entitlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  is_enabled BOOLEAN DEFAULT FALSE,
  status VARCHAR(50) DEFAULT 'not_enabled', -- not_enabled | setup_required | live
  professional_pool JSONB, -- array of professional IDs
  sla_settings JSONB,
  activation_date DATE,
  eap_overview TEXT,
  eap_access_methods JSONB,
  eap_operating_hours TEXT,
  eap_languages JSONB,
  eap_media_urls JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_prof_entitlements_company ON organization_professional_entitlements(company_id);

-- ============================================================
-- PROFESSIONAL REFERRALS
-- ============================================================
CREATE TABLE IF NOT EXISTS professional_referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  referred_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referrer_role VARCHAR(50), -- hr_manager | hr_business_partner | line_manager | executive_sponsor
  reason_category VARCHAR(255),
  context_note TEXT,
  urgency VARCHAR(50) DEFAULT 'standard', -- standard | urgent | crisis
  confidentiality_acknowledged BOOLEAN DEFAULT FALSE,
  suggested_professional_id UUID REFERENCES professionals(id) ON DELETE SET NULL,
  suggested_modality VARCHAR(50),
  status VARCHAR(50) DEFAULT 'referred', -- referred | accepted | in_progress | completed | declined | no_show
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_professional_referrals_company ON professional_referrals(company_id);
CREATE INDEX IF NOT EXISTS idx_professional_referrals_referred_by ON professional_referrals(referred_by);
CREATE INDEX IF NOT EXISTS idx_professional_referrals_employee ON professional_referrals(employee_id);
CREATE INDEX IF NOT EXISTS idx_professional_referrals_professional ON professional_referrals(suggested_professional_id);
CREATE INDEX IF NOT EXISTS idx_professional_referrals_status ON professional_referrals(status);

-- ============================================================
-- PROFESSIONAL CASES (booking/case management)
-- ============================================================
CREATE TABLE IF NOT EXISTS professional_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type VARCHAR(50), -- 'direct'|'referral'
  referral_id UUID REFERENCES professional_referrals(id) ON DELETE SET NULL,
  support_topic VARCHAR(255),
  modality VARCHAR(50), -- video | phone | in_person
  urgency VARCHAR(50) DEFAULT 'standard', -- standard | urgent | crisis
  status VARCHAR(50) DEFAULT 'assigned', -- assigned | proposed_times | confirmed | completed | attendance_confirmed | cancelled | declined | reassigned
  proposed_times JSONB, -- array of datetime options
  confirmed_time TIMESTAMPTZ,
  employee_notes TEXT,
  professional_notes TEXT,
  completion_notes TEXT,
  attendance_confirmed BOOLEAN DEFAULT FALSE,
  assigned_by UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_professional_cases_company ON professional_cases(company_id);
CREATE INDEX IF NOT EXISTS idx_professional_cases_professional ON professional_cases(professional_id);
CREATE INDEX IF NOT EXISTS idx_professional_cases_employee ON professional_cases(employee_id);
CREATE INDEX IF NOT EXISTS idx_professional_cases_referral ON professional_cases(referral_id);
CREATE INDEX IF NOT EXISTS idx_professional_cases_status ON professional_cases(status);
CREATE INDEX IF NOT EXISTS idx_professional_cases_assigned_by ON professional_cases(assigned_by);

-- ============================================================
-- PROFESSIONAL CASE MESSAGES (encrypted messaging)
-- ============================================================
CREATE TABLE IF NOT EXISTS professional_case_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES professional_cases(id) ON DELETE CASCADE,
  sender_type VARCHAR(50) NOT NULL, -- 'employee'|'professional'|'icc_admin'
  sender_id UUID NOT NULL,
  message_text TEXT NOT NULL, -- in production should be encrypted
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_professional_case_messages_case ON professional_case_messages(case_id);
CREATE INDEX IF NOT EXISTS idx_professional_case_messages_sender ON professional_case_messages(sender_id);

-- ============================================================
-- WELLBEING CHALLENGES (redesigned for 3 types)
-- ============================================================
CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by_icc UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  created_by_user UUID REFERENCES users(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  challenge_type VARCHAR(50) NOT NULL, -- 'icc_linked' | 'organisation_specific' | 'hybrid'
  theme_category VARCHAR(255),
  audience_type VARCHAR(50), -- all | department | business_unit | custom
  participation_mode VARCHAR(50) DEFAULT 'opt_in', -- opt_in | auto_enrol
  metric_name VARCHAR(255),
  metric_unit VARCHAR(100),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  requires_evidence BOOLEAN DEFAULT FALSE,
  evidence_type VARCHAR(50), -- photo | screenshot | text | any
  -- Leaderboard / display
  show_leaderboard BOOLEAN DEFAULT TRUE,
  show_snapshots BOOLEAN DEFAULT TRUE,
  leaderboard_visibility VARCHAR(50) DEFAULT 'off', -- off | team | individual_opt_in
  -- Scoring
  scoring_mode VARCHAR(50) DEFAULT 'completion', -- completion | points | bonus
  completion_threshold DECIMAL(5,2),
  -- Certificates
  certificate_enabled BOOLEAN DEFAULT FALSE,
  certificate_text TEXT,
  certificate_logo_url TEXT,
  -- Badges
  badge_enabled BOOLEAN DEFAULT FALSE,
  -- Teams
  team_enabled BOOLEAN DEFAULT FALSE,
  status VARCHAR(50) DEFAULT 'draft', -- draft | active | completed | archived
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (challenge_type IN ('icc_linked','organisation_specific','hybrid'))
);

CREATE INDEX IF NOT EXISTS idx_challenges_company ON challenges(company_id);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_type ON challenges(challenge_type);

-- ============================================================
-- CHALLENGE ORG ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_org_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_org_assignments_challenge ON challenge_org_assignments(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_org_assignments_company ON challenge_org_assignments(company_id);

-- ============================================================
-- CHALLENGE MODULES
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_modules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  module_type VARCHAR(50) NOT NULL, -- 'resource'|'activity'
  title VARCHAR(255),
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  -- For resource modules
  linked_theme_id UUID REFERENCES resource_themes(id) ON DELETE SET NULL,
  linked_milestone_id UUID REFERENCES resource_milestones(id) ON DELETE SET NULL,
  completion_method VARCHAR(50),
  -- For activity modules
  activity_name VARCHAR(255),
  instructions TEXT,
  metric_type VARCHAR(50), -- distance | time | quantity | yes_no
  goal_type VARCHAR(50), -- daily | weekly | cumulative | streak | threshold
  goal_value DECIMAL(10,2),
  max_logs_per_day INTEGER,
  max_logs_per_week INTEGER,
  value_min DECIMAL(10,2),
  value_max DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (module_type IN ('resource','activity'))
);

CREATE INDEX IF NOT EXISTS idx_challenge_modules_challenge ON challenge_modules(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_modules_theme ON challenge_modules(linked_theme_id);
CREATE INDEX IF NOT EXISTS idx_challenge_modules_milestone ON challenge_modules(linked_milestone_id);

-- ============================================================
-- CHALLENGE PARTICIPANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  total_score DECIMAL(10,2) DEFAULT 0,
  UNIQUE(challenge_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_challenge_participants_challenge ON challenge_participants(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_user ON challenge_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_company ON challenge_participants(company_id);

-- ============================================================
-- CHALLENGE ENTRIES
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  participant_id UUID NOT NULL REFERENCES challenge_participants(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  value DECIMAL(10,2) NOT NULL,
  evidence_url TEXT,
  notes TEXT,
  entry_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_entries_participant ON challenge_entries(participant_id);
CREATE INDEX IF NOT EXISTS idx_challenge_entries_challenge ON challenge_entries(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_entries_date ON challenge_entries(entry_date);

-- ============================================================
-- CHALLENGE EVIDENCE
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_evidence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id UUID NOT NULL REFERENCES challenge_entries(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES challenge_participants(id) ON DELETE CASCADE,
  evidence_type VARCHAR(50) DEFAULT 'image', -- image
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  approval_status VARCHAR(50) DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_evidence_entry ON challenge_evidence(entry_id);
CREATE INDEX IF NOT EXISTS idx_challenge_evidence_participant ON challenge_evidence(participant_id);
CREATE INDEX IF NOT EXISTS idx_challenge_evidence_status ON challenge_evidence(approval_status);

-- ============================================================
-- CHALLENGE BADGES
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_badges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  name VARCHAR(255),
  description TEXT,
  icon_url TEXT,
  threshold_type VARCHAR(50),
  threshold_value DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_badges_challenge ON challenge_badges(challenge_id);

-- ============================================================
-- CHALLENGE PARTICIPANT BADGES
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_participant_badges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  participant_id UUID NOT NULL REFERENCES challenge_participants(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES challenge_badges(id) ON DELETE CASCADE,
  earned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_participant_badges_participant ON challenge_participant_badges(participant_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participant_badges_badge ON challenge_participant_badges(badge_id);

-- ============================================================
-- CHALLENGE CERTIFICATES
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  participant_id UUID NOT NULL REFERENCES challenge_participants(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  certificate_html TEXT,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_challenge_certificates_participant ON challenge_certificates(participant_id);
CREATE INDEX IF NOT EXISTS idx_challenge_certificates_challenge ON challenge_certificates(challenge_id);

-- ============================================================
-- CHALLENGE TEAMS
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_teams_challenge ON challenge_teams(challenge_id);

-- ============================================================
-- CHALLENGE TEAM MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES challenge_teams(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES challenge_participants(id) ON DELETE CASCADE,
  UNIQUE(team_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_challenge_team_members_team ON challenge_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_challenge_team_members_participant ON challenge_team_members(participant_id);

-- ============================================================
-- CHALLENGE NUDGES
-- ============================================================
CREATE TABLE IF NOT EXISTS challenge_nudges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  nudge_type VARCHAR(50), -- invitation | join_reminder | inactivity | progress | final_push | completion
  message_template TEXT,
  schedule_rule JSONB, -- cron or relative timing
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenge_nudges_challenge ON challenge_nudges(challenge_id);

-- ============================================================
-- PERFORMANCE OBJECTIVES (Impact Compasses)
-- ============================================================
CREATE TABLE IF NOT EXISTS performance_objectives (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  measure TEXT,
  category_id UUID REFERENCES objective_categories(id) ON DELETE SET NULL,
  template_id UUID REFERENCES objective_templates(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  legacy_status VARCHAR(50),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  due_date DATE,
  is_manually_created BOOLEAN DEFAULT FALSE,
  -- Approval workflow
  approval_status VARCHAR(50) DEFAULT 'pending', -- pending | approved | rejected
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perf_obj_user ON performance_objectives(user_id);
CREATE INDEX IF NOT EXISTS idx_perf_obj_company ON performance_objectives(company_id);
CREATE INDEX IF NOT EXISTS idx_perf_obj_cycle ON performance_objectives(cycle_id);
CREATE INDEX IF NOT EXISTS idx_perf_obj_status ON performance_objectives(status_id);
CREATE INDEX IF NOT EXISTS idx_perf_obj_approved_by ON performance_objectives(approved_by);
CREATE INDEX IF NOT EXISTS idx_perf_obj_created_by ON performance_objectives(created_by);

-- ============================================================
-- PERFORMANCE REFLECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS performance_reflections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  objective_id UUID REFERENCES performance_objectives(id) ON DELETE SET NULL,
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  period VARCHAR(100),
  reflection_type VARCHAR(50) DEFAULT 'self', -- self | manager | peer | functional_manager | solicited
  content TEXT NOT NULL,
  status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  self_rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  manager_reflection TEXT,
  manager_rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  -- Final agreed
  final_agreed_status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  final_agreed_rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  consolidated_notes TEXT,
  is_consolidated BOOLEAN DEFAULT FALSE,
  visibility VARCHAR(50) DEFAULT 'private', -- private | manager | all
  submitted_at TIMESTAMPTZ,
  manager_submitted_at TIMESTAMPTZ,
  -- Sign-off workflow
  employee_signed_off BOOLEAN DEFAULT FALSE,
  employee_signed_off_at TIMESTAMPTZ,
  manager_signed_off BOOLEAN DEFAULT FALSE,
  manager_signed_off_at TIMESTAMPTZ,
  functional_manager_signed_off BOOLEAN DEFAULT FALSE,
  functional_manager_signed_off_at TIMESTAMPTZ,
  -- Functional manager
  functional_manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  functional_manager_reflection TEXT,
  solicited_from_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perf_refl_user ON performance_reflections(user_id);
CREATE INDEX IF NOT EXISTS idx_perf_refl_objective ON performance_reflections(objective_id);
CREATE INDEX IF NOT EXISTS idx_perf_refl_cycle ON performance_reflections(cycle_id);
CREATE INDEX IF NOT EXISTS idx_perf_refl_manager ON performance_reflections(functional_manager_id);
CREATE INDEX IF NOT EXISTS idx_perf_refl_self_rating ON performance_reflections(self_rating_id);
CREATE INDEX IF NOT EXISTS idx_perf_refl_final_status ON performance_reflections(final_agreed_status_id);
CREATE INDEX IF NOT EXISTS idx_perf_refl_final_rating ON performance_reflections(final_agreed_rating_id);

-- ============================================================
-- DEVELOPMENT OBJECTIVES (Growth Focus)
-- ============================================================
CREATE TABLE IF NOT EXISTS development_objectives (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  measure TEXT,
  category_id UUID REFERENCES objective_categories(id) ON DELETE SET NULL,
  template_id UUID REFERENCES objective_templates(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  skill_area VARCHAR(200),
  resources TEXT,
  legacy_status VARCHAR(50),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  target_date DATE,
  is_manually_created BOOLEAN DEFAULT FALSE,
  -- Approval workflow
  approval_status VARCHAR(50) DEFAULT 'pending', -- pending | approved | rejected
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_obj_user ON development_objectives(user_id);
CREATE INDEX IF NOT EXISTS idx_dev_obj_company ON development_objectives(company_id);
CREATE INDEX IF NOT EXISTS idx_dev_obj_cycle ON development_objectives(cycle_id);
CREATE INDEX IF NOT EXISTS idx_dev_obj_status ON development_objectives(status_id);
CREATE INDEX IF NOT EXISTS idx_dev_obj_approved_by ON development_objectives(approved_by);

-- ============================================================
-- DEVELOPMENT REFLECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS development_reflections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  objective_id UUID REFERENCES development_objectives(id) ON DELETE SET NULL,
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  period VARCHAR(100),
  reflection_type VARCHAR(50) DEFAULT 'self', -- self | manager | peer | functional_manager | solicited
  content TEXT NOT NULL,
  key_learnings TEXT,
  next_steps TEXT,
  status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  self_rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  manager_reflection TEXT,
  manager_rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  -- Final agreed
  final_agreed_status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  final_agreed_rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  -- Extended learning fields
  learning_achieved TEXT,
  skills_developed TEXT,
  application_of_learning TEXT,
  consolidated_notes TEXT,
  is_consolidated BOOLEAN DEFAULT FALSE,
  visibility VARCHAR(50) DEFAULT 'private', -- private | manager | all
  submitted_at TIMESTAMPTZ,
  manager_submitted_at TIMESTAMPTZ,
  -- Sign-off workflow
  employee_signed_off BOOLEAN DEFAULT FALSE,
  employee_signed_off_at TIMESTAMPTZ,
  manager_signed_off BOOLEAN DEFAULT FALSE,
  manager_signed_off_at TIMESTAMPTZ,
  -- Functional manager
  functional_manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  functional_manager_reflection TEXT,
  solicited_from_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_refl_user ON development_reflections(user_id);
CREATE INDEX IF NOT EXISTS idx_dev_refl_objective ON development_reflections(objective_id);
CREATE INDEX IF NOT EXISTS idx_dev_refl_cycle ON development_reflections(cycle_id);
CREATE INDEX IF NOT EXISTS idx_dev_refl_manager ON development_reflections(functional_manager_id);
CREATE INDEX IF NOT EXISTS idx_dev_refl_rating ON development_reflections(rating_id);
CREATE INDEX IF NOT EXISTS idx_dev_refl_self_rating ON development_reflections(self_rating_id);

-- ============================================================
-- WELLBEING OBJECTIVES
-- ============================================================
CREATE TABLE IF NOT EXISTS wellbeing_objectives (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  measure TEXT,
  category_id UUID REFERENCES objective_categories(id) ON DELETE SET NULL,
  template_id UUID REFERENCES objective_templates(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  due_date DATE,
  visible_to_manager BOOLEAN DEFAULT FALSE,
  visible_to_functional_manager BOOLEAN DEFAULT FALSE,
  is_manually_created BOOLEAN DEFAULT FALSE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wellbeing_obj_user ON wellbeing_objectives(user_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_obj_company ON wellbeing_objectives(company_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_obj_cycle ON wellbeing_objectives(cycle_id);

-- ============================================================
-- WELLBEING REFLECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS wellbeing_reflections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  objective_id UUID REFERENCES wellbeing_objectives(id) ON DELETE SET NULL,
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  period VARCHAR(100),
  reflection_type VARCHAR(50) DEFAULT 'self', -- self | peer | solicited
  content TEXT NOT NULL,
  status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  manager_reflection TEXT,
  manager_status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  visible_to_functional_manager BOOLEAN DEFAULT FALSE,
  final_agreed_status_id UUID REFERENCES objective_statuses(id) ON DELETE SET NULL,
  consolidation_comments TEXT,
  consolidation_ownership VARCHAR(50) DEFAULT 'joint', -- employee_led | manager_led | joint
  consolidated_notes TEXT,
  is_consolidated BOOLEAN DEFAULT FALSE,
  visible_to_manager BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMPTZ,
  solicited_from_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wellbeing_refl_user ON wellbeing_reflections(user_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_refl_objective ON wellbeing_reflections(objective_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_refl_cycle ON wellbeing_reflections(cycle_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_refl_manager_status ON wellbeing_reflections(manager_status_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_refl_final_status ON wellbeing_reflections(final_agreed_status_id);

-- ============================================================
-- WELLBEING PULSE CHECKS
-- ============================================================
CREATE TABLE IF NOT EXISTS wellbeing_checks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  overall_score INTEGER NOT NULL CHECK (overall_score >= 1 AND overall_score <= 10),
  energy_score INTEGER CHECK (energy_score >= 1 AND energy_score <= 10),
  stress_score INTEGER CHECK (stress_score >= 1 AND stress_score <= 10),
  connection_score INTEGER CHECK (connection_score >= 1 AND connection_score <= 10),
  purpose_score INTEGER CHECK (purpose_score >= 1 AND purpose_score <= 10),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wellbeing_user ON wellbeing_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_company ON wellbeing_checks(company_id);
CREATE INDEX IF NOT EXISTS idx_wellbeing_created_at ON wellbeing_checks(created_at);

-- ============================================================
-- ADHOC NOTES (continuous conversation log)
-- ============================================================
CREATE TABLE IF NOT EXISTS adhoc_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- employee
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- who wrote it
  author_role VARCHAR(50), -- employee | manager | functional_manager
  note_date DATE NOT NULL,
  interaction_type VARCHAR(100), -- 1on1 | coaching | observation | check_in | other
  summary TEXT NOT NULL,
  key_observations TEXT,
  agreed_actions TEXT,
  module_type VARCHAR(50), -- performance | development
  linked_objective_ids JSONB, -- array of objective UUIDs (null = linked to all)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adhoc_notes_company ON adhoc_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_adhoc_notes_user ON adhoc_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_adhoc_notes_author ON adhoc_notes(author_id);
CREATE INDEX IF NOT EXISTS idx_adhoc_notes_date ON adhoc_notes(note_date);

-- ============================================================
-- STAKEHOLDER FEEDBACK
-- ============================================================
CREATE TABLE IF NOT EXISTS stakeholder_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reflection_id UUID, -- performance or development reflection ID
  module_type VARCHAR(50), -- performance | development
  objective_id UUID,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stakeholder_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback_text TEXT,
  rating_id UUID REFERENCES rating_scales(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'pending', -- pending | completed
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stakeholder_feedback_company ON stakeholder_feedback(company_id);
CREATE INDEX IF NOT EXISTS idx_stakeholder_feedback_reflection ON stakeholder_feedback(reflection_id);
CREATE INDEX IF NOT EXISTS idx_stakeholder_feedback_requested_by ON stakeholder_feedback(requested_by);
CREATE INDEX IF NOT EXISTS idx_stakeholder_feedback_stakeholder ON stakeholder_feedback(stakeholder_id);
CREATE INDEX IF NOT EXISTS idx_stakeholder_feedback_status ON stakeholder_feedback(status);

-- ============================================================
-- ATTACHMENTS (generic attachment system)
-- ============================================================
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type VARCHAR(100) NOT NULL, -- performance_objective|development_objective|wellbeing_objective|performance_reflection|development_reflection|wellbeing_reflection|stakeholder_feedback|adhoc_note
  entity_id UUID NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_type VARCHAR(100),
  file_size INTEGER,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_company ON attachments(company_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_by ON attachments(uploaded_by);

-- ============================================================
-- 360 FEEDBACK TEMPLATES
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_360_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by_icc UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE, -- null = ICC standard
  title VARCHAR(500) NOT NULL,
  description TEXT,
  is_standard BOOLEAN DEFAULT FALSE, -- ICC standard template
  categories JSONB, -- e.g. ['Performance Behaviours','Development Capabilities','Wellbeing Indicators']
  rating_scale JSONB, -- {min, max, labels}
  status VARCHAR(50) DEFAULT 'draft', -- draft | active | archived
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_360_templates_company ON feedback_360_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_templates_icc ON feedback_360_templates(created_by_icc);

-- ============================================================
-- 360 FEEDBACK TEMPLATE QUESTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_360_template_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES feedback_360_templates(id) ON DELETE CASCADE,
  category VARCHAR(255),
  question_text TEXT NOT NULL,
  question_type VARCHAR(50), -- rating | text | rating_and_text
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_feedback_360_questions_template ON feedback_360_template_questions(template_id);

-- ============================================================
-- 360 FEEDBACK ASSESSMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_360_assessments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES feedback_360_templates(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- who is being assessed
  cycle_id UUID REFERENCES connect_cycles(id) ON DELETE SET NULL,
  trigger_point VARCHAR(50), -- mid_cycle | end_of_cycle | adhoc
  module_type VARCHAR(50), -- performance | development
  status VARCHAR(50) DEFAULT 'draft', -- draft | in_progress | completed
  min_respondents INTEGER DEFAULT 3,
  anonymous BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_feedback_360_assessments_company ON feedback_360_assessments(company_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_assessments_employee ON feedback_360_assessments(employee_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_assessments_template ON feedback_360_assessments(template_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_assessments_cycle ON feedback_360_assessments(cycle_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_assessments_status ON feedback_360_assessments(status);

-- ============================================================
-- 360 FEEDBACK PARTICIPANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_360_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assessment_id UUID NOT NULL REFERENCES feedback_360_assessments(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_role VARCHAR(50), -- self | manager | functional_manager | stakeholder
  status VARCHAR(50) DEFAULT 'pending', -- pending | completed
  completed_at TIMESTAMPTZ,
  UNIQUE(assessment_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_360_participants_assessment ON feedback_360_participants(assessment_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_participants_user ON feedback_360_participants(participant_id);

-- ============================================================
-- 360 FEEDBACK RESPONSES
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_360_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assessment_id UUID NOT NULL REFERENCES feedback_360_assessments(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES feedback_360_participants(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES feedback_360_template_questions(id) ON DELETE CASCADE,
  rating_value INTEGER,
  comment_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_360_responses_assessment ON feedback_360_responses(assessment_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_responses_participant ON feedback_360_responses(participant_id);
CREATE INDEX IF NOT EXISTS idx_feedback_360_responses_question ON feedback_360_responses(question_id);

-- ============================================================
-- SMILES (Aero Smiles / Recognition)
-- ============================================================
CREATE TABLE IF NOT EXISTS smiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  category_id UUID REFERENCES smile_categories(id) ON DELETE SET NULL,
  points INTEGER DEFAULT 10,
  is_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smiles_to ON smiles(to_user_id);
CREATE INDEX IF NOT EXISTS idx_smiles_from ON smiles(from_user_id);
CREATE INDEX IF NOT EXISTS idx_smiles_company ON smiles(company_id);
CREATE INDEX IF NOT EXISTS idx_smiles_created_at ON smiles(created_at);

-- ============================================================
-- EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  event_type VARCHAR(100), -- meeting | workshop | social | training | webinar
  event_color VARCHAR(20),
  venue VARCHAR(500),
  format VARCHAR(50) DEFAULT 'in_person', -- online | in_person
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  location TEXT,
  meeting_url TEXT,
  is_all_day BOOLEAN DEFAULT FALSE,
  max_attendees INTEGER,
  is_public BOOLEAN DEFAULT TRUE,
  target_type VARCHAR(50) DEFAULT 'all', -- all | department | business_unit | user
  target_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_company ON events(company_id);
CREATE INDEX IF NOT EXISTS idx_events_created_by ON events(created_by);
CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time);

CREATE TABLE IF NOT EXISTS event_attendees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'pending', -- pending | accepted | declined | maybe
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_attendees_event ON event_attendees(event_id);
CREATE INDEX IF NOT EXISTS idx_event_attendees_user ON event_attendees(user_id);

-- ============================================================
-- SURVEYS
-- ============================================================
CREATE TABLE IF NOT EXISTS surveys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  survey_type VARCHAR(50) DEFAULT 'pulse', -- pulse | engagement | feedback | custom
  category VARCHAR(50), -- engagement | wellbeing | culture | leadership
  target_type VARCHAR(50) DEFAULT 'all', -- all | department | business_unit | individual
  target_value TEXT,
  status VARCHAR(50) DEFAULT 'draft', -- draft | active | closed | archived
  is_anonymous BOOLEAN DEFAULT TRUE,
  open_at TIMESTAMPTZ,
  close_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_surveys_company ON surveys(company_id);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(status);
CREATE INDEX IF NOT EXISTS idx_surveys_category ON surveys(category);

-- ============================================================
-- SURVEY SECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS survey_sections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  title VARCHAR(255),
  description TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_survey_sections_survey ON survey_sections(survey_id);

CREATE TABLE IF NOT EXISTS survey_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  section_id UUID REFERENCES survey_sections(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  question_type VARCHAR(50) DEFAULT 'rating', -- rating | text | multiple_choice | yes_no
  options JSONB,
  is_required BOOLEAN DEFAULT TRUE,
  order_index INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_survey_questions_survey ON survey_questions(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_questions_section ON survey_questions(section_id);

CREATE TABLE IF NOT EXISTS survey_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_user ON survey_responses(user_id);

CREATE TABLE IF NOT EXISTS survey_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  response_id UUID NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  answer_text TEXT,
  answer_rating INTEGER,
  answer_choice VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_survey_answers_response ON survey_answers(response_id);
CREATE INDEX IF NOT EXISTS idx_survey_answers_question ON survey_answers(question_id);

-- ============================================================
-- SURVEY TARGET ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS survey_target_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  target_type VARCHAR(50) NOT NULL, -- individual | department | business_unit | all
  target_id UUID, -- user_id or department_id or BU_id
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_target_assignments_survey ON survey_target_assignments(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_target_assignments_target ON survey_target_assignments(target_type, target_id);

-- ============================================================
-- EMAIL TEMPLATES (per-company)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  template_type VARCHAR(100), -- invite | welcome | reminder | notification | custom
  template_token VARCHAR(100),
  template_id_code VARCHAR(100),
  template_category VARCHAR(50), -- email | notification | report
  status VARCHAR(50) DEFAULT 'active', -- active | inactive
  version INTEGER DEFAULT 1,
  variables JSONB,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_company ON email_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_email_templates_type ON email_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_email_templates_status ON email_templates(status);
CREATE INDEX IF NOT EXISTS idx_email_templates_token ON email_templates(template_token);

-- ============================================================
-- EMAIL TEMPLATE VERSIONS (version history)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_template_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  subject VARCHAR(500),
  body_html TEXT,
  body_text TEXT,
  changed_by UUID, -- user or icc_admin
  change_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_template_versions_template ON email_template_versions(template_id);

-- ============================================================
-- ICC EMAIL TEMPLATES (IBL-level templates)
-- ============================================================
CREATE TABLE IF NOT EXISTS icc_email_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  template_type VARCHAR(50), -- email | notification | report
  subject VARCHAR(500),
  body_html TEXT,
  tokens JSONB, -- available tokens
  event_trigger VARCHAR(100), -- user_registration | password_reset | indicator_completed | survey_assigned | smile_awarded
  is_default BOOLEAN DEFAULT TRUE,
  version INTEGER DEFAULT 1,
  status VARCHAR(50) DEFAULT 'active', -- active | inactive
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icc_email_templates_created_by ON icc_email_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_icc_email_templates_trigger ON icc_email_templates(event_trigger);
CREATE INDEX IF NOT EXISTS idx_icc_email_templates_status ON icc_email_templates(status);

-- ============================================================
-- ICC EMAIL TEMPLATE VERSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS icc_email_template_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES icc_email_templates(id) ON DELETE CASCADE,
  version INTEGER,
  subject VARCHAR(500),
  body_html TEXT,
  changed_by UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icc_email_template_versions_template ON icc_email_template_versions(template_id);

-- ============================================================
-- LEARNING SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE, -- null = ICC-managed
  created_by_icc UUID REFERENCES icc_admins(id) ON DELETE SET NULL,
  created_by_user UUID REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  category VARCHAR(50), -- wellbeing | leadership | culture
  facilitator_name VARCHAR(255),
  session_type VARCHAR(50), -- live | recorded | live_plus_recording
  session_date TIMESTAMPTZ,
  duration_minutes INTEGER,
  timezone VARCHAR(100),
  audience_type VARCHAR(50) DEFAULT 'all', -- all | selected_orgs | department | business_unit | group
  audience_value TEXT,
  rsvp_required BOOLEAN DEFAULT TRUE,
  capacity_limit INTEGER,
  live_session_url TEXT,
  backup_url TEXT,
  access_instructions TEXT,
  status VARCHAR(50) DEFAULT 'draft', -- draft | published | completed | cancelled
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_sessions_company ON learning_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_learning_sessions_icc ON learning_sessions(created_by_icc);
CREATE INDEX IF NOT EXISTS idx_learning_sessions_status ON learning_sessions(status);
CREATE INDEX IF NOT EXISTS idx_learning_sessions_date ON learning_sessions(session_date);

-- ============================================================
-- LEARNING SESSION ORG ASSIGNMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_session_org_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_session_org_session ON learning_session_org_assignments(session_id);
CREATE INDEX IF NOT EXISTS idx_learning_session_org_company ON learning_session_org_assignments(company_id);

-- ============================================================
-- LEARNING SESSION RECORDINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_session_recordings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES learning_sessions(id) ON DELETE SET NULL, -- nullable, can be standalone
  title VARCHAR(500) NOT NULL,
  description TEXT,
  recording_type VARCHAR(50), -- uploaded_video | youtube | vimeo | external_link
  recording_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_minutes INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_session_recordings_session ON learning_session_recordings(session_id);

-- ============================================================
-- LEARNING SESSION RSVPs
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_session_rsvps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'yes', -- yes | no | maybe
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_learning_session_rsvps_session ON learning_session_rsvps(session_id);
CREATE INDEX IF NOT EXISTS idx_learning_session_rsvps_user ON learning_session_rsvps(user_id);

-- ============================================================
-- LEARNING SESSION ATTENDANCE
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_session_attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_status VARCHAR(50) DEFAULT 'registered', -- registered | attended | did_not_attend
  marked_at TIMESTAMPTZ,
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_learning_session_attendance_session ON learning_session_attendance(session_id);
CREATE INDEX IF NOT EXISTS idx_learning_session_attendance_user ON learning_session_attendance(user_id);

-- ============================================================
-- SOCIAL FEED POSTS
-- ============================================================
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url TEXT,
  post_type VARCHAR(50) DEFAULT 'general', -- general | achievement | milestone | announcement
  likes_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  is_pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_company ON posts(company_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);

CREATE TABLE IF NOT EXISTS post_likes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_user ON post_likes(user_id);

CREATE TABLE IF NOT EXISTS post_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_user ON post_comments(user_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  type VARCHAR(100), -- smile | event | survey | system | mention
  reference_id UUID,
  reference_type VARCHAR(100),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- ============================================================
-- REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS saved_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  report_type VARCHAR(50) NOT NULL, -- smiles | performance | development | wellbeing | indicators | resources | hris | surveys | engagement | custom
  filters JSONB,
  generated_at TIMESTAMPTZ,
  file_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_company ON saved_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_created_by ON saved_reports(created_by);
CREATE INDEX IF NOT EXISTS idx_saved_reports_type ON saved_reports(report_type);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Seed indicator categories (global, not per-company)
INSERT INTO indicator_categories (name, display_name, description, icon, color, sort_order)
VALUES
  ('mental', 'Mental Wellbeing', 'Emotional and psychological health', 'mind', '#7C3AED', 0),
  ('social', 'Social Wellbeing', 'Connection and community', 'people', '#EC4899', 1),
  ('physical', 'Physical Wellbeing', 'Health and fitness', 'heart', '#EF4444', 2),
  ('financial', 'Financial Wellbeing', 'Money and security', 'wallet', '#F59E0B', 3)
ON CONFLICT DO NOTHING;

-- Seed default email templates (global)
INSERT INTO email_templates (name, subject, body_html, template_type, is_default, template_token, template_id_code, template_category, status)
VALUES
  ('Staff Invitation', 'You have been invited to join {{company_name}} on WellMinds',
   '<h2>Welcome to WellMinds!</h2><p>Hi {{first_name}},</p><p>You have been invited to join <strong>{{company_name}}</strong> on WellMinds — a platform for wellbeing, performance, and growth.</p><p><a href="{{invite_link}}" style="background:#1a8784;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">Accept Invitation</a></p><p>This link expires in 7 days.</p>',
   'invite', TRUE, 'staff_invitation', 'TMPL_STAFF_INVITE', 'email', 'active'),
  ('Password Reset', 'Reset your WellMinds password',
   '<h2>Reset Your Password</h2><p>Hi {{first_name}},</p><p>We received a request to reset your password. Click below to choose a new one:</p><p><a href="{{reset_link}}" style="background:#1a8784;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">Reset Password</a></p><p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>',
   'welcome', TRUE, 'password_reset', 'TMPL_PASSWORD_RESET', 'email', 'active'),
  ('Wellbeing Reminder', 'Time for your weekly wellbeing check-in',
   '<h2>Weekly Check-In</h2><p>Hi {{first_name}},</p><p>It''s time for your weekly wellbeing pulse check. It only takes 2 minutes and helps us support you better.</p><p><a href="{{app_link}}/wellbeing/pulse" style="background:#1a8784;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">Complete Check-In</a></p>',
   'reminder', TRUE, 'wellbeing_reminder', 'TMPL_WELLBEING_REMIND', 'email', 'active'),
  ('New Smile Received', '{{sender_name}} sent you a Smile!',
   '<h2>You received a Smile!</h2><p>Hi {{first_name}},</p><p><strong>{{sender_name}}</strong> sent you a Smile:</p><blockquote style="border-left:4px solid #1a8784;padding:12px 16px;background:#f0fafa;margin:16px 0;">{{message}}</blockquote><p><a href="{{app_link}}/smiles" style="background:#1a8784;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">View Your Smiles</a></p>',
   'notification', TRUE, 'smile_received', 'TMPL_SMILE_RECEIVED', 'notification', 'active'),
  ('Event Invitation', 'You are invited to {{event_title}}',
   '<h2>Event Invitation</h2><p>Hi {{first_name}},</p><p>You are invited to <strong>{{event_title}}</strong></p><p><strong>Date:</strong> {{event_date}}<br><strong>Time:</strong> {{event_time}}<br><strong>Location:</strong> {{event_location}}</p><p><a href="{{event_link}}" style="background:#1a8784;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">RSVP</a></p>',
   'notification', TRUE, 'event_invitation', 'TMPL_EVENT_INVITE', 'notification', 'active'),
  ('Survey Available', 'Your feedback is important — {{survey_title}}',
   '<h2>Survey Available</h2><p>Hi {{first_name}},</p><p>We would love to hear your thoughts on <strong>{{survey_title}}</strong>.</p><p><a href="{{survey_link}}" style="background:#1a8784;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">Take Survey</a></p><p>This survey is {{survey_length}} minutes long. Thank you for your participation!</p>',
   'notification', TRUE, 'survey_available', 'TMPL_SURVEY_AVAILABLE', 'notification', 'active')
ON CONFLICT DO NOTHING;

-- ============================================================
-- SCHEMA NOTES:
-- 1. All tables use UUID primary keys with uuid_generate_v4()
-- 2. All foreign keys are indexed for query performance
-- 3. Frequently queried columns have indexes
-- 4. Two-level admin structure: icc_admins (platform) and users (organization)
-- 5. RBAC via roles / role_permissions / user_roles tables
-- 6. Business units with many-to-many user assignment
-- 7. Multi-department support via user_departments
-- 8. Module subscriptions per company
-- 9. Client registration workflow with approval
-- 10. Connect configurations with weighted progress tracking
-- 11. Professional case management with messaging and referrals
-- 12. Challenge system with modules, badges, certificates, teams, nudges
-- 13. Learning sessions with RSVPs, attendance, recordings
-- 14. 360 feedback with templates, assessments, participants, responses
-- 15. Adhoc notes for continuous conversation logging
-- 16. Generic attachment system for all entity types
-- 17. Stakeholder feedback formalized table
-- 18. ICC-level and company-level email templates with versioning
-- 19. Indicator scheduling system
-- 20. Survey sections and target assignments
-- 21. New joiner visibility settings per company
-- 22. All timestamps use TIMESTAMPTZ for timezone awareness
-- ============================================================
