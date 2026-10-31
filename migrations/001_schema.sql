-- ============================================================
-- InstanceSeg Studio - schema initial
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin', 'annotateur');
CREATE TYPE split_name AS ENUM ('train', 'val', 'test');

-- ---------- Utilisateur ----------
CREATE TABLE utilisateur (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'annotateur',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- unicite insensible a la casse (remplace citext, absent du build embarque)
CREATE UNIQUE INDEX utilisateur_email_lower_uq ON utilisateur (lower(email));
CREATE UNIQUE INDEX utilisateur_username_lower_uq ON utilisateur (lower(username));

-- ---------- Projet ----------
CREATE TABLE projet (
  id          BIGSERIAL PRIMARY KEY,
  nom         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pct_train   INT NOT NULL DEFAULT 80 CHECK (pct_train BETWEEN 0 AND 100),
  pct_val     INT NOT NULL DEFAULT 10 CHECK (pct_val   BETWEEN 0 AND 100),
  pct_test    INT NOT NULL DEFAULT 10 CHECK (pct_test  BETWEEN 0 AND 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES utilisateur(id),
  CONSTRAINT pct_total CHECK (pct_train + pct_val + pct_test = 100)
);

-- ---------- Membre (utilisateur <-> projet, permissions par poste) ----------
CREATE TABLE membre (
  projet_id   BIGINT NOT NULL REFERENCES projet(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  permissions JSONB NOT NULL DEFAULT '{
    "localisation": true, "classification": true, "segmentation": true,
    "validation_instance": true, "validation_image": true
  }'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (projet_id, user_id)
);

-- ---------- Classe ----------
CREATE TABLE classe (
  id         BIGSERIAL PRIMARY KEY,
  projet_id  BIGINT NOT NULL REFERENCES projet(id) ON DELETE CASCADE,
  nom        TEXT NOT NULL,
  couleur    TEXT NOT NULL DEFAULT '#3b82f6',
  z_index    INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (projet_id, nom),
  UNIQUE (projet_id, z_index)
);

-- ---------- Image ----------
CREATE TABLE image (
  id                   BIGSERIAL PRIMARY KEY,
  projet_id            BIGINT NOT NULL REFERENCES projet(id) ON DELETE CASCADE,
  sha256               TEXT NOT NULL,
  chemin               TEXT NOT NULL,              -- chemin relatif sous UPLOAD_DIR
  thumb_chemin         TEXT,                       -- miniature pre-generee
  width                INT NOT NULL,
  height               INT NOT NULL,
  split                split_name NOT NULL,
  negative             BOOLEAN NOT NULL DEFAULT FALSE,   -- aucune instance a tracer
  localisation_done    BOOLEAN NOT NULL DEFAULT FALSE,   -- poste 1 "Terminer" clique
  relocalisation_ajout BOOLEAN NOT NULL DEFAULT FALSE,   -- flag "localisation manquante" : mode AJOUT UNIQUEMENT
  validee              BOOLEAN NOT NULL DEFAULT FALSE,   -- validation d'image (poste 5)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (projet_id, sha256)                            -- anti-doublons par hash, par projet
);
CREATE INDEX idx_image_projet ON image(projet_id);
CREATE INDEX idx_image_split  ON image(projet_id, split);

-- ---------- Instance ----------
-- Le stade (localisee/classifiee/segmentee/complete/validee) est CALCULE
-- a partir des attributs (voir fonction instance_stage), jamais stocke.
CREATE TABLE instance (
  id         BIGSERIAL PRIMARY KEY,
  image_id   BIGINT NOT NULL REFERENCES image(id) ON DELETE CASCADE,
  bbox       JSONB,                                   -- {x,y,w,h} en pixels image entiere
  class_id   BIGINT REFERENCES classe(id) ON DELETE SET NULL,  -- NULLABLE
  polygon    JSONB,                                   -- [[x,y],...] relatif image entiere, NULLABLE
  crop_chemin TEXT,                                   -- crop pre-genere (poste 2/3)
  validee    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,                             -- suppression douce (corbeille)
  created_by BIGINT REFERENCES utilisateur(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_instance_image ON instance(image_id);
CREATE INDEX idx_instance_class ON instance(class_id);

-- Stade calcule d'une instance (jamais stocke)
CREATE FUNCTION instance_stage(b JSONB, c BIGINT, p JSONB, v BOOLEAN, d TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d IS NOT NULL THEN 'supprimee'
    WHEN v THEN 'validee'
    WHEN b IS NOT NULL AND c IS NOT NULL AND p IS NOT NULL THEN 'complete'
    WHEN b IS NOT NULL AND p IS NOT NULL AND c IS NULL THEN 'segmentee'
    WHEN b IS NOT NULL AND c IS NOT NULL AND p IS NULL THEN 'classifiee'
    WHEN b IS NOT NULL THEN 'localisee'
    ELSE 'aucune'
  END;
$$;

CREATE FUNCTION instance_stage(r instance) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT instance_stage(r.bbox, r.class_id, r.polygon, r.validee, r.deleted_at);
$$;

-- ---------- Marque (favori prive par compte) ----------
CREATE TABLE marque (
  image_id   BIGINT NOT NULL REFERENCES image(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (image_id, user_id)
);

-- ---------- Reservation (cache file par utilisateur/poste + verrou) ----------
-- Une ligne = un item reserve/ouvert par un utilisateur sur un poste.
-- PK (item_kind, item_id) => un item n'est ouvert que par UN annotateur a la fois.
CREATE TABLE reservation (
  id         BIGSERIAL PRIMARY KEY,
  projet_id  BIGINT NOT NULL REFERENCES projet(id) ON DELETE CASCADE,
  poste      TEXT NOT NULL CHECK (poste IN
               ('localisation','classification','segmentation','validation_instance','validation_image')),
  item_kind  TEXT NOT NULL CHECK (item_kind IN ('image','instance')),
  item_id    BIGINT NOT NULL,
  user_id    BIGINT NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  ordre      DOUBLE PRECISION NOT NULL DEFAULT random(),  -- ordre aleatoire de la file
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_kind, item_id)
);
CREATE INDEX idx_res_user_poste ON reservation(user_id, poste);
CREATE INDEX idx_res_projet_poste ON reservation(projet_id, poste);

-- ---------- Evenement (journal d'audit append-only) ----------
CREATE TABLE evenement (
  id         BIGSERIAL PRIMARY KEY,
  projet_id  BIGINT REFERENCES projet(id) ON DELETE SET NULL,
  user_id    BIGINT REFERENCES utilisateur(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entite     TEXT NOT NULL,               -- ex: image, instance, projet, classe, membre, marque
  entite_id  BIGINT,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_projet_date ON evenement(projet_id, created_at DESC);
CREATE INDEX idx_event_entite ON evenement(entite, entite_id, created_at DESC);

-- Append-only : interdit toute modification/suppression
CREATE FUNCTION forbid_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evenement est append-only (op % interdit)', TG_OP;
END; $$;
CREATE TRIGGER trg_event_append_only
  BEFORE UPDATE OR DELETE ON evenement
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();
CREATE TRIGGER trg_event_append_only_stmt
  BEFORE TRUNCATE ON evenement
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_event_mutation();

-- ---------- Job d'export / import (suivi des taches de fond) ----------
CREATE TABLE job (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,               -- import_images | export | purge_trash
  projet_id  BIGINT REFERENCES projet(id) ON DELETE CASCADE,
  user_id    BIGINT REFERENCES utilisateur(id) ON DELETE SET NULL,
  statut     TEXT NOT NULL DEFAULT 'pending' CHECK (statut IN ('pending','running','done','error')),
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  resultat   JSONB,
  erreur     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_statut ON job(statut, created_at);
