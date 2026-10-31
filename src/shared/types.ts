export type Role = 'admin' | 'annotateur';
export type Split = 'train' | 'val' | 'test';
export type Poste =
  | 'localisation'
  | 'classification'
  | 'segmentation'
  | 'validation_instance'
  | 'validation_image';

export const POSTES: Poste[] = [
  'localisation',
  'classification',
  'segmentation',
  'validation_instance',
  'validation_image',
];

export type InstanceStage =
  | 'aucune'
  | 'localisee'
  | 'classifiee'
  | 'segmentee'
  | 'complete'
  | 'validee'
  | 'supprimee';

export const POSTE_LABEL: Record<Poste, string> = {
  localisation: 'Localisation',
  classification: 'Classification',
  segmentation: 'Segmentation',
  validation_instance: 'Validation d\u2019instance',
  validation_image: 'Validation d\u2019image',
};

export interface BBox {
  x: number; y: number; w: number; h: number;
}
export type Point = [number, number];

export interface User {
  id: number; email: string; username: string; role: Role; created_at: string;
}
export interface Project {
  id: number; nom: string; description: string;
  pct_train: number; pct_val: number; pct_test: number; created_at: string;
}
export interface Member {
  user_id: number; username: string; email: string; role: Role; permissions: Record<Poste, boolean>;
}
export interface ClassItem {
  id: number; projet_id: number; nom: string; couleur: string; z_index: number;
}
export interface Image {
  id: number; projet_id: number; sha256: string; chemin: string; thumb_chemin: string | null;
  width: number; height: number; split: Split;
  negative: boolean; localisation_done: boolean; relocalisation_ajout: boolean; validee: boolean;
  created_at: string;
}
export interface Instance {
  id: number; image_id: number; bbox: BBox | null; class_id: number | null;
  polygon: Point[] | null; crop_chemin: string | null; validee: boolean;
  deleted_at: string | null; created_by: number | null; created_at: string; updated_at: string;
  stage?: InstanceStage; class_nom?: string | null; couleur?: string | null;
}
export interface QueueItem {
  kind: 'image' | 'instance';
  id: number;
  image_id: number;
  stage?: InstanceStage;
  locked_by_me: boolean;
  locked_by?: number | null;
  locked_by_username?: string | null;
  width: number; height: number; chemin: string; thumb: string | null;
  instance?: Instance;
  negative?: boolean;
  count_total: number;
  count_mine: number;
}
export interface EventItem {
  id: number; action: string; entite: string; entite_id: number | null;
  user_id: number | null; username: string | null; details: any; created_at: string;
}

export function stageOf(i: Pick<Instance, 'bbox' | 'class_id' | 'polygon' | 'validee' | 'deleted_at'>): InstanceStage {
  if (i.deleted_at) return 'supprimee';
  if (i.validee) return 'validee';
  const b = !!i.bbox, c = i.class_id != null, p = !!i.polygon;
  if (b && c && p) return 'complete';
  if (b && p && !c) return 'segmentee';
  if (b && c && !p) return 'classifiee';
  if (b) return 'localisee';
  return 'aucune';
}
