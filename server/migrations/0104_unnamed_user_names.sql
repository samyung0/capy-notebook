-- An account without a name is named after the part of its email before the
-- @, at most 60 characters (human authorization, 2026-10-21). Accounts
-- provisioned earlier took the whole address, cut to 60 characters, so those
-- names move to the local part; a name the user typed stays.
UPDATE users
SET name = left(split_part(email, '@', 1), 60)
WHERE email IS NOT NULL
  AND lower(name) = lower(left(email, 60))
  AND split_part(email, '@', 1) <> '';
