INSERT INTO event_roles (
  id, event_id, user_id, role, invitation_id, granted_by_user_id,
  revoked_at, revoked_by_user_id, created_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  events.id,
  events.owner_user_id,
  owner_roles.role,
  NULL,
  events.owner_user_id,
  NULL,
  NULL,
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM events
CROSS JOIN (
  SELECT 'organizer' AS role
  UNION ALL
  SELECT 'reviewer'
) AS owner_roles
WHERE NOT EXISTS (
  SELECT 1
  FROM event_roles
  WHERE event_roles.event_id = events.id
    AND event_roles.user_id = events.owner_user_id
    AND event_roles.role = owner_roles.role
    AND event_roles.revoked_at IS NULL
);
