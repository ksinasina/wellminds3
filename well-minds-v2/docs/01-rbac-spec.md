# Spec 01 — RBAC Rebuild (Role-Based Access Control)

**Roadmap epic:** P0-1
**Status:** Draft v1 — for review

## Motivation

Two explicit calls in the notes:

1. **ICC Admin §Admin Users** — *"for each employee or each administrator's name we would need to list out all of the modules on ICC and then have the ability to click on which modules this particular admin user has access to then we would need to be able to click further to say on each of these modules do they have view access edit access delete access or All access"*.
2. **Company App §HR Section** — *"setting up of the access controls for each employee within the organization"*, and throughout: per-module gates (professionals only visible if org subscribed; challenges authoring only for users with permission; survey authoring only for users with permission; etc.).

## Current state

| Layer | What exists | What's wrong |
|---|---|---|
| Schema | `roles(company_id, name)`, `role_permissions(role_id, module, can_view, can_add, can_edit, can_delete)`, `user_roles(user_id, role_id)` | `role_permissions.module` is capped at 8 values by `CHECK`; most modules in the platform aren't representable. |
| Schema | `icc_admins.role` is a single VARCHAR `super_admin\|content_admin\|support` | No per-module grain on the ICC side at all. |
| Routes | Ad-hoc `req.user.role === 'admin'` checks scattered in various routes | No centralized gate. Easy to forget. |

## Target state

One middleware factory used by every protected route. Two separate tables (company vs ICC) using the same shape.

### Schema deltas

```sql
-- Expand the company-side module enum to cover every module the platform has.
-- Because Postgres CHECK cannot be altered in place, drop the old one and
-- swap in a FK to a lookup table instead — easier to extend going forward.

CREATE TABLE IF NOT EXISTS permission_modules (
  key VARCHAR(100) PRIMARY KEY,          -- e.g. 'social_wall'
  scope VARCHAR(20) NOT NULL,            -- 'company' | 'icc'
  label VARCHAR(255) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Drop the CHECK constraint on role_permissions.module
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_module_check;
-- Add FK (values must already be seeded)
ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_fk
  FOREIGN KEY (module) REFERENCES permission_modules(key);

-- Seed values (company scope)
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
  ('settings_connect_cycles',  'company', 'Connect Cycles',              270);

-- ICC-side mirror
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

-- ICC-scope modules
INSERT INTO permission_modules (key, scope, label, sort_order) VALUES
  ('icc_dashboard',            'icc', 'ICC Dashboard',                  10),
  ('icc_clients',              'icc', 'Client Registrations & Orgs',    20),
  ('icc_indicators',           'icc', 'Indicator Builder',              30),
  ('icc_surveys',              'icc', 'Survey Builder',                 40),
  ('icc_pulse_checks',         'icc', 'Pulse Checks (global)',          50),
  ('icc_resources',            'icc', 'Wellbeing Resources',            60),
  ('icc_sessions',             'icc', 'Learning Sessions',              70),
  ('icc_professionals',        'icc', 'Professionals Directory',        80),
  ('icc_challenges',           'icc', 'Challenges',                     90),
  ('icc_comms',                'icc', 'Communication Templates',       100),
  ('icc_analytics',            'icc', 'Analytics',                     110),
  ('icc_admin_users',          'icc', 'Admin Users & Roles',           120),
  ('icc_billing',              'icc', 'Billing / Subscriptions',       130);

-- Seed 3 system roles on the ICC side
INSERT INTO icc_roles (name, is_system) VALUES
  ('Super Admin', TRUE),
  ('Content Admin', TRUE),
  ('Support', TRUE);
```

### Seeded default system roles (company side)

Shipped ready-to-use. Company admin can edit permissions, but the role rows cannot be deleted (`is_system = TRUE`).

| System role | Intent |
|---|---|
| `Company Admin` | Everything — can create other roles |
| `HR Manager` | HR reports, staff mgmt, comms, master data, all connect cycles (view) |
| `Line Manager` | View reports on own team, manage own team's connect cycles |
| `Employee` | Default — self-service on profile, participate in everything they're assigned |

### Middleware

One file, one function. Replaces ad-hoc role checks everywhere.

```js
// src/middleware/requirePermission.js
module.exports = function requirePermission(module, action /* 'view'|'add'|'edit'|'delete' */) {
  return async (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthenticated' });

    // ICC admin context vs company user context
    const scope = user.type === 'icc_admin' ? 'icc' : 'company';
    const column = `can_${action}`;

    const sql = scope === 'icc'
      ? `SELECT 1 FROM icc_admin_roles iar
           JOIN icc_role_permissions irp ON irp.role_id = iar.role_id
          WHERE iar.admin_id = $1 AND irp.module = $2 AND irp.${column} = TRUE
          LIMIT 1`
      : `SELECT 1 FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1 AND rp.module = $2 AND rp.${column} = TRUE
          LIMIT 1`;

    const { rowCount } = await req.db.query(sql, [user.id, module]);
    if (rowCount === 0) return res.status(403).json({ error: 'Forbidden', module, action });
    next();
  };
};
```

### Usage in routes

```js
const requirePermission = require('../middleware/requirePermission');

router.get   ('/posts',       auth, requirePermission('social_wall', 'view'),   handlers.list);
router.post  ('/posts',       auth, requirePermission('social_wall', 'add'),    handlers.create);
router.patch ('/posts/:id',   auth, requirePermission('social_wall', 'edit'),   handlers.update);
router.delete('/posts/:id',   auth, requirePermission('social_wall', 'delete'), handlers.remove);
```

### Frontend implications

- A new settings screen `/settings/roles` where a company admin with `settings_rbac:edit` can see a matrix of **Role × Module × (view/add/edit/delete)** and tick boxes.
- A parallel ICC-admin screen `/icc/admin-users` rebuilding the current basic UI into a matrix.
- A helper endpoint `GET /api/me/permissions` returning the current user's effective permission set, so the frontend can hide nav items the user can't access.

### Rollout & backfill

1. Ship migration — seed `permission_modules` and `icc_roles`.
2. Seed a `Company Admin` role per company and grant it **every** company-scope module at all 4 actions.
3. For each existing user, assign them to `Company Admin` if they're the only user, or to `Employee` otherwise. Hand-migrate anything non-default.
4. Apply `requirePermission` middleware route-by-route across v2 routes (v1 routes continue to work under the old ad-hoc checks until deprecated).

### Tests

- Unit: middleware returns 403 when user lacks permission; 200 when they have it; 401 when no user.
- Integration: create role → add perms → assign to user → hit endpoint → expect success.
- Security: insertion of an arbitrary string into `permission_modules.key` fails (FK catches it).

### Risks / caveats

- Middleware runs a DB query per protected request. Add a 60-second in-memory cache keyed by `user_id:module:action` to reduce load. Invalidate on `role_permissions` or `user_roles` change via a simple pub/sub (or just short TTL).
- `is_system` roles must never be deletable — enforced at the DB via trigger and at the route.
