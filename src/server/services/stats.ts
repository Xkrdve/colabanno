// Statistiques admin : calculees a la volee, jamais stockees.
import { query } from '../db/pool.js';

export async function stats(projetId: number, f: {
  classId?: number; userId?: number; jour?: string; stage?: string;
}) {
  const cond: string[] = ['i.projet_id=$1'];
  const params: any[] = [projetId];
  if (f.userId) { params.push(f.userId); cond.push(`x.created_by=$${params.length}`); }
  if (f.classId) { params.push(f.classId); cond.push(`x.class_id=$${params.length}`); }
  if (f.jour) { params.push(f.jour); cond.push(`date(x.created_at AT TIME ZONE 'UTC')=$${params.length}::date`); }
  const where = cond.join(' AND ');

  const parClasse = await query(
    `SELECT c.id AS class_id, c.nom, count(*)::int AS n
     FROM instance x JOIN image i ON i.id=x.image_id JOIN classe c ON c.id=x.class_id
     WHERE ${where} AND x.deleted_at IS NULL GROUP BY c.id, c.nom ORDER BY n DESC`, params);

  const parStage = await query(
    `SELECT instance_stage(x) AS stage, count(*)::int AS n
     FROM instance x JOIN image i ON i.id=x.image_id
     WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params);

  const images = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE i.validee)::int AS validees,
            count(*) FILTER (WHERE i.negative)::int AS negatives,
            count(*) FILTER (WHERE NOT i.localisation_done)::int AS a_localiser,
            count(*) FILTER (WHERE i.relocalisation_ajout)::int AS relocalisation
     FROM image i WHERE i.projet_id=$1`, [projetId]);

  // Rythme d'annotations par poste (deduit des evenements d'audit) et par annotateur
  const posteCond: string[] = ['e.projet_id=$1'];
  const posteParams: any[] = [projetId];
  if (f.userId) { posteParams.push(f.userId); posteCond.push(`e.user_id=$${posteParams.length}`); }
  if (f.jour) { posteParams.push(f.jour); posteCond.push(`date(e.created_at AT TIME ZONE 'UTC')=$${posteParams.length}::date`); }
  const posteWhere = posteCond.join(' AND ');
  const rythmePoste = await query(
    `SELECT CASE
              WHEN action='image_localisee' OR action='image_relocalisee' THEN 'localisation'
              WHEN action='instance_classifier' THEN 'classification'
              WHEN action='instance_segmenter' THEN 'segmentation'
              WHEN action LIKE 'instance_validee' OR action LIKE 'instance_refusee%' THEN 'validation_instance'
              WHEN action IN ('image_validee','image_localisation_manquante','image_negative') THEN 'validation_image'
              ELSE 'autre' END AS poste,
            count(*)::int AS n
     FROM evenement e WHERE ${posteWhere} AND action IN
       ('image_localisee','image_relocalisee','instance_classifier','instance_segmenter',
        'instance_validee','instance_refusee_vers_classification','instance_refusee_vers_segmentation',
        'image_validee','image_localisation_manquante','image_negative')
     GROUP BY 1 ORDER BY 2 DESC`, posteParams);

  const rythmeUser = await query(
    `SELECT e.user_id, u.username, count(*)::int AS n
     FROM evenement e JOIN utilisateur u ON u.id=e.user_id
     WHERE ${posteWhere} AND e.action IN
       ('image_localisee','image_relocalisee','instance_classifier','instance_segmenter',
        'instance_validee','instance_refusee_vers_classification','instance_refusee_vers_segmentation',
        'image_validee','image_localisation_manquante','image_negative')
     GROUP BY 1,2 ORDER BY 3 DESC`, posteParams);

  return {
    par_classe: parClasse.rows,
    par_stage: parStage.rows,
    images: images.rows[0],
    rythme_par_poste: rythmePoste.rows,
    rythme_par_annotateur: rythmeUser.rows,
  };
}
