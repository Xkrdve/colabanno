# InstanceSeg Studio

Application web complète d'**annotation collaborative d'images pour la segmentation d'instances**, pensée pour la production de série : plusieurs annotateurs travaillent simultanément sur 5 postes, avec une interface sobre et industrielle.

- **SPA** React + TypeScript, canvas d'annotation **HTML5 Canvas**
- **API REST + WebSocket** (Node/Express), **PostgreSQL** (JSONB, verrous de ligne, audit append-only)
- **Docker Compose** pour le dev (`db` + `api`), ou Postgres embarqué local sans Docker

## Démarrage rapide

```bash
cp .env.example .env

# Option A — Docker Compose (recommandé en dev poste à poste)
docker compose up --build
# API + WS : http://127.0.0.1:4000   (SPA servie en prod buildée ; en dev utiliser l'option B)

# Option B — sans Docker (Postgres embarqué, loopback uniquement)
npm run dev        # db embarquée + API (tsx) + Vite sur :5173
# ou séparément : npm run dev:db  |  npm run dev:server  |  npm run dev:client
```

Compte admin initial : **admin / admin123** (à changer). Aucun auto-inscription : l'admin crée les comptes (`POST /api/auth/users`).

## Modèle de données (PostgreSQL)

`utilisateur` (e-mail, username, hash bcrypt, rôle admin/annotateur) · `projet` (nom, description, % train/val/test) · `membre` (utilisateur↔projet, **permissions par poste** en JSONB) · `classe` (nom, **z-index**) · `image` (**SHA-256 unique par projet**, chemin, **split fixe**, flag négative) · `instance` (**bbox JSONB**, **classe NULLABLE**, **polygone JSONB NULLABLE**, validée, `deleted_at` = suppression douce) · `marque` (favori privé) · `evenement` (**journal append-only** : trigger qui bloque UPDATE/DELETE/TRUNCATE) · `reservation` (**cache + verrou** par utilisateur/poste, `UNIQUE(item_kind, item_id)`).

Le **stade d'une instance** (`localisee / classifiee / segmentee / complete / validee / supprimee`) est **calculé** par la fonction SQL `instance_stage()` à partir des attributs — jamais stocké.

## Pipeline — 5 postes

| Poste | Comportement |
|---|---|
| 1. Localisation | Bbox sur l'image entière, une image à la fois. « Terminer » décharge l'image ; sans box → **négative** → validation d'image directe. |
| 2. Classification | **Crop uniquement** (jamais l'image entière) ; clic classe → enregistre et passe à l'instance suivante. |
| 3. Segmentation | Crop uniquement ; polygone éditable (ajout/suppression/déplacement de points), Modifier / Valider. |
| 4. Validation d'instance | Valide, ou **refus ciblé** : → classification (**classe effacée**, polygone conservé) / → segmentation (**polygone effacé**, classe conservée) ; commentaire transmis à l'annotateur qui reprend. |
| 5. Validation d'image | Quand toutes les instances sont validées (ou image négative). Valide, ou flag **« localisation manquante »** → retour poste 1 en **mode AJOUT UNIQUEMENT** (instances validées conservées). |

**Contestation** (postes 2 et 3) : la localisation peut être contestée → instance en **corbeille** (suppression douce), sans commentaire ni notification.

## Files & concurrence

- Une file par poste, ordre **aléatoire** (`ORDER BY random()`), jamais séquentiel.
- **Réserve de 50 items** par annotateur et par poste, re-complétée automatiquement à chaque item terminé.
- **Verrou** : un item ouvert crée une ligne `reservation` (contrainte d'unicité) → l'item est réservé et **invisible pour les autres** ; **WebSocket** (`/ws?projet=&token=`) pousse les compteurs en temps réel.
- Toute action sur un item vérifie le propriétaire du verrou : **l'annulation est bloquée (409)** si l'item a été repris par un autre utilisateur.

## Interface

- Connexion par **e-mail OU username** + mot de passe.
- Page des projets filtrée par autorisation ; admin : création de projets, autorisation d'annotateurs, **classes avec z-index par glisser-déposer**, suppression de classe avec **warning** puis reclassification (`class_id=NULL`) ou suppression des instances.
- **Import multiple** PNG/JPG, anti-doublons SHA-256 + comparaison en arrière-plan (non bloquante), split aléatoire à l'import puis fixe, miniatures et crops pré-générés (sharp).
- Écran de poste identique partout : barre gauche (file), canvas central, panneau droit spécifique au poste (validation : toggle instance/image). **← →** pour naviguer, **Ctrl+Z / Ctrl+Y** sur 10 modifications (la pile traverse les items), passage auto à un nouvel item aléatoire après chaque validation de stade.
- Vue globale : images par stade, filtres (stade, classes présentes), **marques privées**, **audit par image** chronologique (admin), **corbeille** avec restauration (admin, **purge auto à 7 jours**).
- **Stats admin** calculées à la volée : instances/classe, images validées, stades, rythme par poste et par annotateur ; filtres classe, annotateur, jour, stade.
- **Exports** : **COCO**, **YOLO-seg**, **segmentation sémantique** (aplat des instances, chevauchements tranchés par z-index). Filtres (classes, images, période), splits respectés. Manuel à la demande + **export automatique périodique** activable ; worker en tâche de fond, destination locale configurable (`EXPORT_DIR`).

## Tests & scénario e2e

```bash
npm test           # 18 tests : concurrence (verrous, race, réserve 50), pipeline complet,
                   # parseurs COCO/YOLO-seg, audit append-only, purge corbeille
npm run e2e        # scénario de bout en bout démontrable (voir ci-dessous)
```

Le scénario `scripts/e2e-demo.ts` enchaîne, contre une vraie base PostgreSQL embarquée et le vrai serveur HTTP : **import (avec doublon ignoré) → localisation (dont 1 image négative et 1 relocalisée en mode ajout) → classification → segmentation → validation d'instance avec refus + commentaire → validation d'image → stats → exports des 3 formats → audit**.

## Arborescence

```
migrations/          001_schema.sql (tables, enums, instance_stage(), trigger append-only)
                     002_seed_admin.sql
src/server/          index.ts (REST+WS), routes/ (auth, projects, images, postes),
                     services/ (queue+verrous, workflow, images, exports, stats, audit), ws.ts
src/shared/          types.ts (Postes, stades calculés côté client aussi)
client/              SPA React+TS (Vite) : login, projets, admin, poste (canvas), vue globale, stats
scripts/             dev-db.ts (Postgres embarqué), migrate.ts, e2e-demo.ts, dev-all.mjs
tests/               locks.test.ts, pipeline.test.ts, exports.test.ts, helpers.ts
docker-compose.yml   db (postgres:16) + api
```

## Variables d'environnement (voir `.env.example`)

`DATABASE_URL`, `JWT_SECRET`, `PORT`, `UPLOAD_DIR`, `EXPORT_DIR`, `EMBEDDED_PG*` (Postgres embarqué sans Docker), `TRASH_RETENTION_DAYS=7`, `AUTO_EXPORT_*`.
