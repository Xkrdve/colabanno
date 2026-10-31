-- Seed : compte admin par defaut (cree via bcryptjs, mot de passe : admin123
-- a changer imperativement au premier login en production).
INSERT INTO utilisateur (email, username, password_hash, role)
VALUES (
  'admin@local',
  'admin',
  '$2a$10$JsQ29/3C.jfKshCwTU80EOggLtHl07anrFxM85tHE3oj.fekKtqSa', -- bcrypt(admin123)
  'admin'
) ON CONFLICT ((lower(email))) DO NOTHING;
