-- Schema baseline exported from the existing Node.js database (structure only, no data).
SET FOREIGN_KEY_CHECKS=0;

CREATE TABLE `crm_audit_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `action_type` varchar(100) NOT NULL,
  `module_name` varchar(50) NOT NULL,
  `old_value` longtext,
  `new_value` longtext,
  `ip_address` varchar(45) NOT NULL,
  `timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_audit_logs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_contacts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `institution_id` int(11) NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `email` varchar(100) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `job_title` varchar(150) NOT NULL,
  `influence_level` varchar(50) NOT NULL,
  `notes` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `institution_id` (`institution_id`),
  CONSTRAINT `crm_contacts_ibfk_1` FOREIGN KEY (`institution_id`) REFERENCES `crm_institutions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_institutions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(200) NOT NULL,
  `type` varchar(50) NOT NULL DEFAULT 'PROSPECT',
  `tax_id` varchar(50) DEFAULT NULL,
  `address` text,
  `region_id` int(11) NOT NULL,
  `department_id` int(11) NOT NULL,
  `city_id` int(11) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `website` varchar(150) DEFAULT NULL,
  `notes` text,
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_active` tinyint(1) DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  UNIQUE KEY `tax_id` (`tax_id`),
  KEY `region_id` (`region_id`),
  KEY `department_id` (`department_id`),
  KEY `city_id` (`city_id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `crm_institutions_ibfk_1` FOREIGN KEY (`region_id`) REFERENCES `crm_ref_regions` (`id`),
  CONSTRAINT `crm_institutions_ibfk_2` FOREIGN KEY (`department_id`) REFERENCES `crm_ref_departments` (`id`),
  CONSTRAINT `crm_institutions_ibfk_3` FOREIGN KEY (`city_id`) REFERENCES `crm_ref_cities` (`id`),
  CONSTRAINT `crm_institutions_ibfk_4` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_login_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `username` varchar(50) NOT NULL,
  `ip_address` varchar(45) NOT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `client_type` enum('web_portal','mobile_pwa','unknown') NOT NULL DEFAULT 'unknown',
  `status` enum('SUCCESS','FAILED','BLOCKED') NOT NULL,
  `failure_reason` varchar(100) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_login_history_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_mission_associates` (
  `mission_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  PRIMARY KEY (`mission_id`,`user_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_mission_associates_ibfk_1` FOREIGN KEY (`mission_id`) REFERENCES `crm_missions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_mission_associates_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_mission_attachments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mission_id` int(11) NOT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_path` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_size` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `mission_id` (`mission_id`),
  CONSTRAINT `crm_mission_attachments_ibfk_1` FOREIGN KEY (`mission_id`) REFERENCES `crm_missions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_mission_target_opportunities` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mission_target_id` int(11) NOT NULL,
  `title` varchar(150) NOT NULL,
  `need_description` text NOT NULL,
  `proposed_solution` text,
  `estimated_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
  `priority` enum('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  `maturity` enum('DISCOVERY','QUALIFIED','PROPOSAL','NEGOTIATION','DECISION') NOT NULL DEFAULT 'DISCOVERY',
  `expected_deadline` date DEFAULT NULL,
  `tender_reference` varchar(120) DEFAULT NULL,
  `current_supplier` varchar(160) DEFAULT NULL,
  `notes` text,
  `linked_opportunity_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mission_target_opportunity` (`mission_target_id`),
  KEY `fk_target_opportunities_pipeline` (`linked_opportunity_id`),
  CONSTRAINT `fk_target_opportunities_pipeline` FOREIGN KEY (`linked_opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_target_opportunities_target` FOREIGN KEY (`mission_target_id`) REFERENCES `crm_mission_targets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_mission_targets` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mission_id` int(11) NOT NULL,
  `institution_id` int(11) NOT NULL,
  `visit_order` int(11) NOT NULL DEFAULT '1',
  `priority` enum('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  `potential` enum('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  `contact_name` varchar(150) DEFAULT NULL,
  `contact_role` varchar(120) DEFAULT NULL,
  `contact_phone` varchar(40) DEFAULT NULL,
  `contact_email` varchar(190) DEFAULT NULL,
  `notes` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mission_target_institution` (`mission_id`,`institution_id`),
  KEY `idx_mission_targets_order` (`mission_id`,`visit_order`),
  KEY `fk_mission_targets_institution` (`institution_id`),
  CONSTRAINT `fk_mission_targets_institution` FOREIGN KEY (`institution_id`) REFERENCES `crm_institutions` (`id`),
  CONSTRAINT `fk_mission_targets_mission` FOREIGN KEY (`mission_id`) REFERENCES `crm_missions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_missions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `objective_id` int(11) NOT NULL,
  `institution_id` int(11) NOT NULL,
  `title` varchar(150) NOT NULL,
  `description` text,
  `scheduled_date` datetime NOT NULL,
  `duration_hours` int(11) DEFAULT '2',
  `primary_commercial_id` int(11) NOT NULL,
  `region_id` int(11) NOT NULL,
  `department_id` int(11) NOT NULL,
  `city_id` int(11) NOT NULL,
  `base_city_id` int(11) DEFAULT NULL,
  `travel_scope` enum('IN_CITY','OUT_OF_CITY') DEFAULT NULL,
  `departure_at` datetime DEFAULT NULL,
  `return_at` datetime DEFAULT NULL,
  `transport_mode` varchar(40) DEFAULT NULL,
  `accommodation_required` tinyint(1) NOT NULL DEFAULT '0',
  `estimated_travel_cost` decimal(15,2) NOT NULL DEFAULT '0.00',
  `client_request_id` varchar(36) DEFAULT NULL,
  `status` enum('DRAFT','SUBMITTED','IN_VALIDATION','VALIDATED','PLANNED','IN_PROGRESS','COMPLETED','CLOSED','REJECTED','CANCELLED','POSTPONED') DEFAULT 'DRAFT',
  `rejection_reason` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `mission_reference` varchar(40) DEFAULT NULL,
  `mission_type` varchar(50) DEFAULT 'PROSPECTION',
  `strategic_objective` varchar(80) DEFAULT NULL,
  `expected_result` text,
  `target_decision_maker` varchar(150) DEFAULT NULL,
  `target_technical_prescriber` varchar(150) DEFAULT NULL,
  `target_influencer` varchar(150) DEFAULT NULL,
  `need_hypotheses` text,
  `visit_approach` text,
  `key_questions` text,
  `risks` text,
  `planned_measures` text,
  `completion_request` text,
  `gate1_validated_at` datetime DEFAULT NULL,
  `started_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `key_messages` text,
  `target_contacts` text,
  `gate1_validated_by` int(11) DEFAULT NULL,
  `order_verification_token` varchar(96) DEFAULT NULL,
  `check_in_at` datetime DEFAULT NULL,
  `check_in_latitude` decimal(10,7) DEFAULT NULL,
  `check_in_longitude` decimal(10,7) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `client_request_id` (`client_request_id`),
  KEY `objective_id` (`objective_id`),
  KEY `institution_id` (`institution_id`),
  KEY `primary_commercial_id` (`primary_commercial_id`),
  KEY `region_id` (`region_id`),
  KEY `department_id` (`department_id`),
  KEY `city_id` (`city_id`),
  CONSTRAINT `crm_missions_ibfk_1` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`),
  CONSTRAINT `crm_missions_ibfk_2` FOREIGN KEY (`institution_id`) REFERENCES `crm_institutions` (`id`),
  CONSTRAINT `crm_missions_ibfk_3` FOREIGN KEY (`primary_commercial_id`) REFERENCES `users` (`id`),
  CONSTRAINT `crm_missions_ibfk_4` FOREIGN KEY (`region_id`) REFERENCES `crm_ref_regions` (`id`),
  CONSTRAINT `crm_missions_ibfk_5` FOREIGN KEY (`department_id`) REFERENCES `crm_ref_departments` (`id`),
  CONSTRAINT `crm_missions_ibfk_6` FOREIGN KEY (`city_id`) REFERENCES `crm_ref_cities` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `title` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_id` int(11) DEFAULT NULL,
  `is_read` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_notifications_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_objectives` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `title` text NOT NULL,
  `description` text,
  `parent_id` int(11) DEFAULT NULL,
  `period_type` varchar(50) NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `assignee_id` int(11) DEFAULT NULL,
  `target_team` varchar(50) DEFAULT NULL,
  `target_qty` decimal(15,2) DEFAULT NULL,
  `target_qty_unit` varchar(50) DEFAULT 'FCFA',
  `target_qlty` text,
  `status` enum('DRAFT','SUBMITTED','CORRECTION','REJECTED','VALIDATED','ASSIGNED','IN_PROGRESS','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `performance_status` enum('NOT_EVALUATED','NOT_ACHIEVED','UNDER_EXPECTATIONS','ACHIEVED','EXCEEDED') DEFAULT 'NOT_EVALUATED',
  `code` varchar(50) DEFAULT NULL,
  `domain_id` int(11) DEFAULT NULL,
  `kpi_id` int(11) DEFAULT NULL,
  `objective_nature` enum('QUANTITATIVE','QUALITATIVE') NOT NULL DEFAULT 'QUANTITATIVE',
  `target_value` decimal(15,2) DEFAULT NULL,
  `unit` varchar(50) DEFAULT 'FCFA',
  `min_level` decimal(15,2) DEFAULT NULL,
  `expected_level` decimal(15,2) DEFAULT NULL,
  `excellent_level` decimal(15,2) DEFAULT NULL,
  `direction` varchar(100) DEFAULT NULL,
  `department` varchar(100) DEFAULT NULL,
  `service` varchar(100) DEFAULT NULL,
  `responsible_id` int(11) DEFAULT NULL,
  `achieved_value` decimal(15,2) DEFAULT '0.00',
  `achievement_rate` decimal(5,2) DEFAULT '0.00',
  `observations` text,
  `qualitative_criteria` json DEFAULT NULL,
  `qualitative_rating` enum('NOT_ACHIEVED','UNDER_EXPECTATIONS','ACHIEVED','EXCEEDED') DEFAULT NULL,
  `qualitative_evidence` text,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `parent_id` (`parent_id`),
  KEY `assignee_id` (`assignee_id`),
  KEY `created_by` (`created_by`),
  KEY `fk_obj_domain` (`domain_id`),
  KEY `fk_obj_kpi` (`kpi_id`),
  KEY `fk_obj_resp` (`responsible_id`),
  CONSTRAINT `crm_objectives_ibfk_1` FOREIGN KEY (`parent_id`) REFERENCES `crm_objectives` (`id`) ON DELETE SET NULL,
  CONSTRAINT `crm_objectives_ibfk_2` FOREIGN KEY (`assignee_id`) REFERENCES `users` (`id`),
  CONSTRAINT `crm_objectives_ibfk_3` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_obj_domain` FOREIGN KEY (`domain_id`) REFERENCES `objectif_domaines` (`id`),
  CONSTRAINT `fk_obj_kpi` FOREIGN KEY (`kpi_id`) REFERENCES `kpis` (`id`),
  CONSTRAINT `fk_obj_resp` FOREIGN KEY (`responsible_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_opportunities` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `institution_id` int(11) NOT NULL,
  `mission_id` int(11) DEFAULT NULL,
  `title` varchar(150) NOT NULL,
  `need_description` text NOT NULL,
  `estimated_amount` decimal(15,2) NOT NULL,
  `priority` varchar(50) DEFAULT 'MEDIUM',
  `status` varchar(50) NOT NULL DEFAULT 'DETECTED',
  `pipeline_stage` varchar(50) NOT NULL DEFAULT 'DETECTION',
  `assigned_to` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `code` varchar(50) DEFAULT NULL,
  `final_amount` decimal(15,2) DEFAULT NULL,
  `decision_date` timestamp NULL DEFAULT NULL,
  `lost_reason` text,
  `validated_by` int(11) DEFAULT NULL,
  `validated_at` timestamp NULL DEFAULT NULL,
  `archived_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `institution_id` (`institution_id`),
  KEY `mission_id` (`mission_id`),
  KEY `assigned_to` (`assigned_to`),
  KEY `fk_opp_validated_by` (`validated_by`),
  CONSTRAINT `crm_opportunities_ibfk_1` FOREIGN KEY (`institution_id`) REFERENCES `crm_institutions` (`id`),
  CONSTRAINT `crm_opportunities_ibfk_2` FOREIGN KEY (`mission_id`) REFERENCES `crm_missions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `crm_opportunities_ibfk_3` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_opp_validated_by` FOREIGN KEY (`validated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_opportunity_actions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `opportunity_id` int(11) NOT NULL,
  `title` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `action_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `assigned_to` int(11) DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `status` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'PENDING',
  `completed_at` timestamp NULL DEFAULT NULL,
  `created_by` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `due_at_utc` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `opportunity_id` (`opportunity_id`),
  KEY `assigned_to` (`assigned_to`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `crm_opportunity_actions_ibfk_1` FOREIGN KEY (`opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_opportunity_actions_ibfk_2` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `crm_opportunity_actions_ibfk_3` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_opportunity_attachments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `opportunity_id` int(11) NOT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_path` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_size` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `opportunity_id` (`opportunity_id`),
  CONSTRAINT `crm_opportunity_attachments_ibfk_1` FOREIGN KEY (`opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_opportunity_comments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `opportunity_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `comment` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `opportunity_id` (`opportunity_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_opportunity_comments_ibfk_1` FOREIGN KEY (`opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_opportunity_comments_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_opportunity_mission_links` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `opportunity_id` int(11) NOT NULL,
  `mission_id` int(11) NOT NULL,
  `link_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'follow_up',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `opportunity_id` (`opportunity_id`),
  KEY `mission_id` (`mission_id`),
  CONSTRAINT `crm_opportunity_mission_links_ibfk_1` FOREIGN KEY (`opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_opportunity_mission_links_ibfk_2` FOREIGN KEY (`mission_id`) REFERENCES `crm_missions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_opportunity_stage_histories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `opportunity_id` int(11) NOT NULL,
  `old_status` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `new_status` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `action` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `comment` text COLLATE utf8mb4_unicode_ci,
  `performed_by` int(11) NOT NULL,
  `performed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `opportunity_id` (`opportunity_id`),
  KEY `performed_by` (`performed_by`),
  CONSTRAINT `crm_opportunity_stage_histories_ibfk_1` FOREIGN KEY (`opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_opportunity_stage_histories_ibfk_2` FOREIGN KEY (`performed_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_cities` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `department_id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL,
  `name_en` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `department_id` (`department_id`),
  CONSTRAINT `crm_ref_cities_ibfk_1` FOREIGN KEY (`department_id`) REFERENCES `crm_ref_departments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_ref_countries` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_departments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `region_id` int(11) NOT NULL,
  `code` varchar(10) NOT NULL,
  `name` varchar(100) NOT NULL,
  `name_en` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `region_id` (`region_id`),
  CONSTRAINT `crm_ref_departments_ibfk_1` FOREIGN KEY (`region_id`) REFERENCES `crm_ref_regions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_ref_documentary_observations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_influence_levels` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_institution_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_mission_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_period_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_priorities` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_ref_regions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(10) NOT NULL,
  `name` varchar(100) NOT NULL,
  `country_id` int(11) DEFAULT NULL,
  `name_en` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `fk_ref_regions_country` (`country_id`),
  CONSTRAINT `fk_ref_regions_country` FOREIGN KEY (`country_id`) REFERENCES `crm_ref_countries` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_report_attachments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `report_id` int(11) NOT NULL,
  `file_name` varchar(255) NOT NULL,
  `file_path` varchar(255) NOT NULL,
  `file_size` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `report_id` (`report_id`),
  CONSTRAINT `crm_report_attachments_ibfk_1` FOREIGN KEY (`report_id`) REFERENCES `crm_reports` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_report_comments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `activity_report_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `comment` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `activity_report_id` (`activity_report_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_report_comments_ibfk_1` FOREIGN KEY (`activity_report_id`) REFERENCES `crm_reports` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_report_comments_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_report_histories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `activity_report_id` int(11) NOT NULL,
  `old_status` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `new_status` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `action` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `comment` text COLLATE utf8mb4_unicode_ci,
  `performed_by` int(11) NOT NULL,
  `performed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `activity_report_id` (`activity_report_id`),
  KEY `performed_by` (`performed_by`),
  CONSTRAINT `crm_report_histories_ibfk_1` FOREIGN KEY (`activity_report_id`) REFERENCES `crm_reports` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_report_histories_ibfk_2` FOREIGN KEY (`performed_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_report_opportunities` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `activity_report_id` int(11) NOT NULL,
  `opportunity_id` int(11) NOT NULL,
  `relation_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_report_opportunity` (`activity_report_id`,`opportunity_id`),
  KEY `opportunity_id` (`opportunity_id`),
  CONSTRAINT `crm_report_opportunities_ibfk_1` FOREIGN KEY (`activity_report_id`) REFERENCES `crm_reports` (`id`) ON DELETE CASCADE,
  CONSTRAINT `crm_report_opportunities_ibfk_2` FOREIGN KEY (`opportunity_id`) REFERENCES `crm_opportunities` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_reports` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) DEFAULT NULL,
  `report_type` varchar(50) NOT NULL DEFAULT 'mission_report',
  `mission_id` int(11) DEFAULT NULL,
  `objective_id` int(11) DEFAULT NULL,
  `institution_id` int(11) DEFAULT NULL,
  `commercial_id` int(11) DEFAULT NULL,
  `team_id` int(11) DEFAULT NULL,
  `period_start` date DEFAULT NULL,
  `period_end` date DEFAULT NULL,
  `executive_summary` text,
  `results` text,
  `diagnosis` text,
  `administrations_visited` text,
  `persons_met` text,
  `difficulties` text,
  `recommendations` text,
  `next_steps` text,
  `generated_from` varchar(50) NOT NULL DEFAULT 'system',
  `generated_by` int(11) DEFAULT NULL,
  `submitted_by` int(11) DEFAULT NULL,
  `submitted_at` timestamp NULL DEFAULT NULL,
  `validated_by` int(11) DEFAULT NULL,
  `validated_at` timestamp NULL DEFAULT NULL,
  `rejected_by` int(11) DEFAULT NULL,
  `rejected_at` timestamp NULL DEFAULT NULL,
  `rejection_reason` text,
  `correction_requested_by` int(11) DEFAULT NULL,
  `correction_requested_at` timestamp NULL DEFAULT NULL,
  `correction_comment` text,
  `archived_by` int(11) DEFAULT NULL,
  `archived_at` timestamp NULL DEFAULT NULL,
  `pdf_path` varchar(255) DEFAULT NULL,
  `status` varchar(50) NOT NULL DEFAULT 'BROUILLON_AUTO',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mission_id` (`mission_id`),
  UNIQUE KEY `code` (`code`),
  KEY `fk_reports_objective_id` (`objective_id`),
  KEY `fk_reports_institution_id` (`institution_id`),
  KEY `fk_reports_commercial_id` (`commercial_id`),
  KEY `fk_reports_generated_by` (`generated_by`),
  KEY `fk_reports_submitted_by` (`submitted_by`),
  KEY `fk_reports_validated_by` (`validated_by`),
  KEY `fk_reports_rejected_by` (`rejected_by`),
  KEY `fk_reports_correction_requested_by` (`correction_requested_by`),
  KEY `fk_reports_archived_by` (`archived_by`),
  CONSTRAINT `crm_reports_ibfk_1` FOREIGN KEY (`mission_id`) REFERENCES `crm_missions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reports_archived_by` FOREIGN KEY (`archived_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_commercial_id` FOREIGN KEY (`commercial_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_correction_requested_by` FOREIGN KEY (`correction_requested_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_generated_by` FOREIGN KEY (`generated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_institution_id` FOREIGN KEY (`institution_id`) REFERENCES `crm_institutions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_objective_id` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_rejected_by` FOREIGN KEY (`rejected_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_validated_by` FOREIGN KEY (`validated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `crm_sync_conflicts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `record_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `record_id` int(11) NOT NULL,
  `local_data` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `server_data` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `resolved_data` longtext COLLATE utf8mb4_unicode_ci,
  `resolution_choice` enum('KEEP_LOCAL','KEEP_SERVER','MERGED') COLLATE utf8mb4_unicode_ci NOT NULL,
  `resolved_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_sync_conflicts_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_sync_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `sync_date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actions_count` int(11) DEFAULT '0',
  `status` enum('SUCCESS','PARTIAL_ERROR','FAILED') COLLATE utf8mb4_unicode_ci DEFAULT 'SUCCESS',
  `details` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `crm_sync_history_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `crm_sync_receipts` (
  `user_id` int(11) NOT NULL,
  `request_id` varchar(120) NOT NULL,
  `payload_hash` char(64) NOT NULL,
  `result_json` json NOT NULL,
  `local_aliases` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`,`request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE `followup_reminders` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `action_id` int(11) NOT NULL,
  `recipient_id` int(11) NOT NULL,
  `due_at_utc` datetime NOT NULL,
  `hours_before` int(11) NOT NULL,
  `scheduled_at_utc` datetime NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'scheduled',
  `notification_id` bigint(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `reminder_once` (`action_id`,`recipient_id`,`due_at_utc`,`hours_before`),
  KEY `status` (`status`,`scheduled_at_utc`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE `job_descriptions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `title` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `role_category` enum('SYSTEM','COMMERCIAL','DIRECTION','ADMIN') COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `title` (`title`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `job_feature_permissions` (
  `job_description_id` int(11) NOT NULL,
  `module_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `feature_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `can_view` tinyint(1) DEFAULT '0',
  `can_create` tinyint(1) DEFAULT '0',
  `can_update` tinyint(1) DEFAULT '0',
  `can_delete` tinyint(1) DEFAULT '0',
  `can_view_all` tinyint(1) DEFAULT '0',
  `can_reorganize` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`job_description_id`,`module_id`,`feature_id`),
  CONSTRAINT `job_feature_permissions_ibfk_1` FOREIGN KEY (`job_description_id`) REFERENCES `job_descriptions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `kpis` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `domain_id` int(11) NOT NULL,
  `type` enum('QUANTITATIVE','QUALITATIVE','FINANCIAL','PERCENTAGE','CALCULATED','MANUAL') COLLATE utf8mb4_unicode_ci NOT NULL,
  `unit` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `calculation_source` enum('MISSIONS','OPPORTUNITIES','REPORTS','ACTIVITIES','MANUAL') COLLATE utf8mb4_unicode_ci NOT NULL,
  `calculation_rule` text COLLATE utf8mb4_unicode_ci,
  `active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `domain_id` (`domain_id`),
  CONSTRAINT `kpis_ibfk_1` FOREIGN KEY (`domain_id`) REFERENCES `objectif_domaines` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_deliveries` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `notification_id` bigint(20) NOT NULL,
  `channel` varchar(10) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `attempts` int(11) NOT NULL DEFAULT '0',
  `next_attempt_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `locked_until` datetime DEFAULT NULL,
  `last_error` varchar(160) DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notification_channel` (`notification_id`,`channel`),
  KEY `status` (`status`,`next_attempt_at`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE `notification_push_subscriptions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `endpoint_hash` char(64) NOT NULL,
  `subscription` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `endpoint_hash` (`endpoint_hash`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE `objectif_affectations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `objective_id` int(11) NOT NULL,
  `type` enum('TEAM','COMMERCIAL','REGION','DEPARTMENT') COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_id` int(11) DEFAULT NULL,
  `target_name` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `value_allocated` decimal(15,2) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `objective_id` (`objective_id`),
  CONSTRAINT `objectif_affectations_ibfk_1` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `objectif_domaines` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `objectif_formations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `objective_id` int(11) NOT NULL,
  `theme` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `goal` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `period` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority` enum('LOW','MEDIUM','HIGH') COLLATE utf8mb4_unicode_ci DEFAULT 'MEDIUM',
  `status` enum('PENDING','APPROVED','REJECTED','COMPLETED') COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `objective_id` (`objective_id`),
  CONSTRAINT `objectif_formations_ibfk_1` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `objectif_historiques` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `objective_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `action` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `old_value` longtext COLLATE utf8mb4_unicode_ci,
  `new_value` longtext COLLATE utf8mb4_unicode_ci,
  `comments` text COLLATE utf8mb4_unicode_ci,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `objective_id` (`objective_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `objectif_historiques_ibfk_1` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`) ON DELETE CASCADE,
  CONSTRAINT `objectif_historiques_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `objectif_moyens` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `objective_id` int(11) NOT NULL,
  `type` enum('BUDGET','VEHICLE','HUMAN_RESOURCES','TRAINING','EQUIPMENT','MARKETING_SUPPORT') COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `quantity` int(11) DEFAULT '1',
  `estimated_cost` decimal(15,2) DEFAULT '0.00',
  `validated_cost` decimal(15,2) DEFAULT '0.00',
  `approval_status` enum('PENDING','APPROVED','REJECTED') COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `objective_id` (`objective_id`),
  CONSTRAINT `objectif_moyens_ibfk_1` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `objectif_resultats` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `objective_id` int(11) NOT NULL,
  `date_calculated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `result_type` enum('QUANTITATIVE','QUALITATIVE') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'QUANTITATIVE',
  `achieved_value` decimal(15,2) DEFAULT NULL,
  `target_value` decimal(15,2) DEFAULT NULL,
  `gap` decimal(15,2) DEFAULT NULL,
  `achievement_rate` decimal(5,2) NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `recorded_by` int(11) DEFAULT NULL,
  `qualitative_rating` enum('NOT_ACHIEVED','UNDER_EXPECTATIONS','ACHIEVED','EXCEEDED') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `qualitative_evidence` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `objective_id` (`objective_id`),
  KEY `recorded_by` (`recorded_by`),
  CONSTRAINT `objectif_resultats_ibfk_1` FOREIGN KEY (`objective_id`) REFERENCES `crm_objectives` (`id`) ON DELETE CASCADE,
  CONSTRAINT `objectif_resultats_ibfk_2` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `password_reset_tokens` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `ticket_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `otp_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `attempts` int(11) DEFAULT '0',
  `expires_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `used_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ticket_hash` (`ticket_hash`),
  KEY `idx_password_reset_user` (`user_id`),
  KEY `idx_password_reset_expiry` (`expires_at`),
  CONSTRAINT `password_reset_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `refresh_tokens` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `token_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `token_hash` (`token_hash`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `refresh_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `revoked_access_tokens` (
  `token_hash` char(64) NOT NULL,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`token_hash`),
  KEY `expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE `user_authorized_devices` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `device_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_name` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `fingerprint` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `authorized_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`,`device_id`),
  CONSTRAINT `user_authorized_devices_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `full_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `first_name` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `role` enum('SYSTEM','COMMERCIAL','DIRECTION','ADMIN') COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_verified` tinyint(1) DEFAULT '0',
  `is_active` tinyint(1) DEFAULT '1',
  `job_description_id` int(11) DEFAULT NULL,
  `base_city_id` int(11) DEFAULT NULL,
  `mfa_secret` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mfa_enabled` tinyint(1) DEFAULT '0',
  `failed_login_attempts` int(11) DEFAULT '0',
  `blocked_until` timestamp NULL DEFAULT NULL,
  `last_login` timestamp NULL DEFAULT NULL,
  `avatar_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_activity` timestamp NULL DEFAULT NULL,
  `last_active_client` enum('web_portal','mobile_pwa','unknown') COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `settings` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `last_mfa_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `auth_version` int(11) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`),
  KEY `job_description_id` (`job_description_id`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`job_description_id`) REFERENCES `job_descriptions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS=1;
