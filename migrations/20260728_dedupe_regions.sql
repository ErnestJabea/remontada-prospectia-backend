-- Migration SQL : Nettoyage et Dédoublonnage du référentiel des Régions (crm_ref_regions)
-- Date : 2026-07-28
-- Description : Réaffecte les départements, institutions et missions liées aux régions doublons (IDs 11 à 20)
--               vers les IDs officiels uniques (IDs 1 à 10), met à jour la langue anglaise, et supprime les doublons.

START TRANSACTION;

-- 1. Réaffectation des Départements
UPDATE crm_ref_departments SET region_id = 1 WHERE region_id = 12;
UPDATE crm_ref_departments SET region_id = 2 WHERE region_id = 15;
UPDATE crm_ref_departments SET region_id = 3 WHERE region_id = 18;
UPDATE crm_ref_departments SET region_id = 4 WHERE region_id = 19;
UPDATE crm_ref_departments SET region_id = 5 WHERE region_id = 16;
UPDATE crm_ref_departments SET region_id = 6 WHERE region_id = 14;
UPDATE crm_ref_departments SET region_id = 7 WHERE region_id = 11;
UPDATE crm_ref_departments SET region_id = 8 WHERE region_id = 13;
UPDATE crm_ref_departments SET region_id = 9 WHERE region_id = 17;
UPDATE crm_ref_departments SET region_id = 10 WHERE region_id = 20;

-- 2. Réaffectation des Institutions / Structures
UPDATE crm_institutions SET region_id = 1 WHERE region_id = 12;
UPDATE crm_institutions SET region_id = 2 WHERE region_id = 15;
UPDATE crm_institutions SET region_id = 3 WHERE region_id = 18;
UPDATE crm_institutions SET region_id = 4 WHERE region_id = 19;
UPDATE crm_institutions SET region_id = 5 WHERE region_id = 16;
UPDATE crm_institutions SET region_id = 6 WHERE region_id = 14;
UPDATE crm_institutions SET region_id = 7 WHERE region_id = 11;
UPDATE crm_institutions SET region_id = 8 WHERE region_id = 13;
UPDATE crm_institutions SET region_id = 9 WHERE region_id = 17;
UPDATE crm_institutions SET region_id = 10 WHERE region_id = 20;

-- 3. Réaffectation des Missions de suivi terrain
UPDATE crm_missions SET region_id = 1 WHERE region_id = 12;
UPDATE crm_missions SET region_id = 2 WHERE region_id = 15;
UPDATE crm_missions SET region_id = 3 WHERE region_id = 18;
UPDATE crm_missions SET region_id = 4 WHERE region_id = 19;
UPDATE crm_missions SET region_id = 5 WHERE region_id = 16;
UPDATE crm_missions SET region_id = 6 WHERE region_id = 14;
UPDATE crm_missions SET region_id = 7 WHERE region_id = 11;
UPDATE crm_missions SET region_id = 8 WHERE region_id = 13;
UPDATE crm_missions SET region_id = 9 WHERE region_id = 17;
UPDATE crm_missions SET region_id = 10 WHERE region_id = 20;

-- 4. Mise à jour des traductions anglaises officielles sur les IDs 1 à 10
UPDATE crm_ref_regions SET name_en = 'Center' WHERE id = 1;
UPDATE crm_ref_regions SET name_en = 'Littoral' WHERE id = 2;
UPDATE crm_ref_regions SET name_en = 'West' WHERE id = 3;
UPDATE crm_ref_regions SET name_en = 'South' WHERE id = 4;
UPDATE crm_ref_regions SET name_en = 'North' WHERE id = 5;
UPDATE crm_ref_regions SET name_en = 'Far North' WHERE id = 6;
UPDATE crm_ref_regions SET name_en = 'Adamawa' WHERE id = 7;
UPDATE crm_ref_regions SET name_en = 'East' WHERE id = 8;
UPDATE crm_ref_regions SET name_en = 'North West' WHERE id = 9;
UPDATE crm_ref_regions SET name_en = 'South West' WHERE id = 10;

-- 5. Suppression des lignes de régions doublons (IDs 11 à 20)
DELETE FROM crm_ref_regions WHERE id IN (11, 12, 13, 14, 15, 16, 17, 18, 19, 20);

COMMIT;
