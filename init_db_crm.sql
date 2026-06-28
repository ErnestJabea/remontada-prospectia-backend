-- =====================================================
-- BASE DE DONNÉES : nexus_crm (SÉPARÉE de nexus_inc)
-- MODULE : ERP Remontada Prospectia
-- VERSION : 1.0.0
-- =====================================================

CREATE DATABASE IF NOT EXISTS nexus_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE nexus_crm;

-- =====================================================
-- 1. AUTHENTIFICATION & UTILISATEURS
-- =====================================================

CREATE TABLE IF NOT EXISTS job_descriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    role_category ENUM('SYSTEM', 'COMMERCIAL', 'DIRECTION', 'ADMIN') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    email VARCHAR(100) UNIQUE,
    phone VARCHAR(20),
    role ENUM('SYSTEM', 'COMMERCIAL', 'DIRECTION', 'ADMIN') NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    job_description_id INT,
    mfa_secret VARCHAR(255) DEFAULT NULL,
    mfa_enabled BOOLEAN DEFAULT FALSE,
    failed_login_attempts INT DEFAULT 0,
    blocked_until TIMESTAMP NULL DEFAULT NULL,
    last_login TIMESTAMP NULL DEFAULT NULL,
    last_activity TIMESTAMP NULL DEFAULT NULL,
    last_active_client ENUM('web_portal', 'mobile_pwa', 'unknown') DEFAULT 'unknown',
    avatar_url VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS job_feature_permissions (
    job_description_id INT NOT NULL,
    module_id VARCHAR(50) NOT NULL,
    feature_id VARCHAR(50) NOT NULL,
    can_view BOOLEAN DEFAULT FALSE,
    can_create BOOLEAN DEFAULT FALSE,
    can_update BOOLEAN DEFAULT FALSE,
    can_delete BOOLEAN DEFAULT FALSE,
    can_view_all BOOLEAN DEFAULT FALSE,
    can_reorganize BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (job_description_id, module_id, feature_id),
    FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Tokens JWT révocables
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Appareils autorisés (PWA)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    ticket_hash CHAR(64) UNIQUE NOT NULL,
    otp_hash VARCHAR(255) NOT NULL,
    attempts INT DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_password_reset_user (user_id),
    INDEX idx_password_reset_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_authorized_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    device_name VARCHAR(150),
    fingerprint VARCHAR(255),
    authorized_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (user_id, device_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================
-- 2. RÉFÉRENTIELS GÉOGRAPHIQUES
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_ref_countries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_ref_regions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    country_id INT DEFAULT NULL,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL,
    FOREIGN KEY (country_id) REFERENCES crm_ref_countries(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_ref_departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    region_id INT NOT NULL,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL,
    FOREIGN KEY (region_id) REFERENCES crm_ref_regions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_ref_cities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    department_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL,
    FOREIGN KEY (department_id) REFERENCES crm_ref_departments(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 3. CRM CORE — OBJECTIFS
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_objectives (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    parent_id INT DEFAULT NULL,
    period_type VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    assignee_id INT DEFAULT NULL,
    target_team VARCHAR(50) DEFAULT NULL,
    target_qty DECIMAL(15,2) DEFAULT NULL,
    target_qty_unit VARCHAR(50) DEFAULT 'FCFA',
    target_qlty TEXT,
    status ENUM('DRAFT', 'SUBMITTED', 'VALIDATED', 'ASSIGNED', 'IN_PROGRESS', 'ACHIEVED', 'NOT_ACHIEVED', 'CLOSED', 'CANCELLED') DEFAULT 'DRAFT',
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES crm_objectives(id) ON DELETE SET NULL,
    FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 4. CRM CORE — INSTITUTIONS & CONTACTS
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_institutions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) UNIQUE NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'PROSPECT',
    tax_id VARCHAR(50) UNIQUE DEFAULT NULL,
    address TEXT,
    region_id INT NOT NULL,
    department_id INT NOT NULL,
    city_id INT NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(100),
    website VARCHAR(150),
    notes TEXT,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (region_id) REFERENCES crm_ref_regions(id),
    FOREIGN KEY (department_id) REFERENCES crm_ref_departments(id),
    FOREIGN KEY (city_id) REFERENCES crm_ref_cities(id),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    institution_id INT NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(50),
    job_title VARCHAR(150) NOT NULL,
    influence_level VARCHAR(50) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (institution_id) REFERENCES crm_institutions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 5. MISSIONS COMMERCIALES
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_missions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    objective_id INT NOT NULL,
    institution_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    scheduled_date DATETIME NOT NULL,
    duration_hours INT DEFAULT 2,
    primary_commercial_id INT NOT NULL,
    region_id INT NOT NULL,
    department_id INT NOT NULL,
    city_id INT NOT NULL,
    status ENUM('DRAFT', 'SUBMITTED', 'IN_VALIDATION', 'VALIDATED', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED', 'POSTPONED') DEFAULT 'DRAFT',
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (objective_id) REFERENCES crm_objectives(id) ON DELETE RESTRICT,
    FOREIGN KEY (institution_id) REFERENCES crm_institutions(id) ON DELETE RESTRICT,
    FOREIGN KEY (primary_commercial_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (region_id) REFERENCES crm_ref_regions(id),
    FOREIGN KEY (department_id) REFERENCES crm_ref_departments(id),
    FOREIGN KEY (city_id) REFERENCES crm_ref_cities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_mission_associates (
    mission_id INT NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (mission_id, user_id),
    FOREIGN KEY (mission_id) REFERENCES crm_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 6. OPPORTUNITÉS COMMERCIALES
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_opportunities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    institution_id INT NOT NULL,
    mission_id INT DEFAULT NULL,
    title VARCHAR(150) NOT NULL,
    need_description TEXT NOT NULL,
    estimated_amount DECIMAL(15,2) NOT NULL,
    priority VARCHAR(50) DEFAULT 'MEDIUM',
    status VARCHAR(50) NOT NULL DEFAULT 'DETECTED',
    pipeline_stage VARCHAR(50) NOT NULL DEFAULT 'DETECTION',
    assigned_to INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (institution_id) REFERENCES crm_institutions(id) ON DELETE RESTRICT,
    FOREIGN KEY (mission_id) REFERENCES crm_missions(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 7. RAPPORTS DE MISSIONS
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mission_id INT UNIQUE NOT NULL,
    executive_summary TEXT NOT NULL,
    administrations_visited TEXT NOT NULL,
    persons_met TEXT NOT NULL,
    difficulties TEXT,
    recommendations TEXT,
    status ENUM('DRAFT', 'SUBMITTED', 'VALIDATED', 'REJECTED') DEFAULT 'DRAFT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (mission_id) REFERENCES crm_missions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_report_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    file_size INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES crm_reports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 8. TRAÇABILITÉ & SYNCHRONISATION
-- =====================================================

CREATE TABLE IF NOT EXISTS crm_audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    module_name VARCHAR(50) NOT NULL,
    old_value LONGTEXT DEFAULT NULL,
    new_value LONGTEXT DEFAULT NULL,
    ip_address VARCHAR(45) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_login_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    username VARCHAR(50) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    user_agent VARCHAR(255) DEFAULT NULL,
    client_type ENUM('web_portal', 'mobile_pwa', 'unknown') NOT NULL DEFAULT 'unknown',
    status ENUM('SUCCESS', 'FAILED', 'BLOCKED') NOT NULL,
    failure_reason VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_sync_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    sync_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actions_count INT DEFAULT 0,
    status ENUM('SUCCESS', 'PARTIAL_ERROR', 'FAILED') DEFAULT 'SUCCESS',
    details TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS crm_sync_conflicts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    record_type VARCHAR(50) NOT NULL,
    record_id INT NOT NULL,
    local_data LONGTEXT NOT NULL,
    server_data LONGTEXT NOT NULL,
    resolved_data LONGTEXT,
    resolution_choice ENUM('KEEP_LOCAL', 'KEEP_SERVER', 'MERGED') NOT NULL,
    resolved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- =====================================================
-- SEED — DONNÉES INITIALES
-- =====================================================

-- Fiches de poste
INSERT IGNORE INTO job_descriptions (id, title, description, role_category) VALUES
(1, 'Directeur Général', 'Pilotage stratégique et validation finale', 'DIRECTION'),
(2, 'Administrateur Système', 'Gestion de la sécurité et des accès', 'SYSTEM'),
(3, 'Commercial Terrain Junior', 'Prospection et relation client de premier niveau', 'COMMERCIAL'),
(4, 'Commercial Terrain Senior', 'Prospection avancée et gestion de grands comptes', 'COMMERCIAL');

-- Permissions par fiche de poste (mod-crm = module CRM)
INSERT IGNORE INTO job_feature_permissions
(job_description_id, module_id, feature_id, can_view, can_view_all, can_create, can_update, can_delete, can_reorganize)
VALUES
-- Commercial Junior
(3, 'crm', 'objectives',    1, 0, 0, 0, 0, 0),
(3, 'crm', 'missions',      1, 0, 1, 1, 0, 0),
(3, 'crm', 'reports',       1, 0, 1, 1, 0, 0),
(3, 'crm', 'opportunities', 1, 0, 1, 1, 0, 1),
(3, 'crm', 'institutions',  1, 1, 1, 1, 0, 0),
-- Commercial Senior
(4, 'crm', 'objectives',    1, 1, 0, 0, 0, 0),
(4, 'crm', 'missions',      1, 1, 1, 1, 0, 0),
(4, 'crm', 'reports',       1, 1, 1, 1, 0, 0),
(4, 'crm', 'opportunities', 1, 1, 1, 1, 1, 1),
(4, 'crm', 'institutions',  1, 1, 1, 1, 1, 0),
-- Direction — accès complet
(1, 'crm', 'objectives',    1, 1, 1, 1, 1, 1),
(1, 'crm', 'missions',      1, 1, 1, 1, 1, 1),
(1, 'crm', 'reports',       1, 1, 1, 1, 1, 1),
(1, 'crm', 'opportunities', 1, 1, 1, 1, 1, 1),
(1, 'crm', 'institutions',  1, 1, 1, 1, 1, 1);

-- Référentiels géographiques (Cameroun)
INSERT IGNORE INTO crm_ref_countries (id, code, name, name_en) VALUES
(1, 'CMR', 'Cameroun', 'Cameroon');

INSERT IGNORE INTO crm_ref_regions (id, country_id, code, name, name_en) VALUES
(1, 1, 'CE', 'Centre', 'Center'),
(2, 1, 'LT', 'Littoral', 'Littoral'),
(3, 1, 'OU', 'Ouest', 'West'),
(4, 1, 'SU', 'Sud', 'South'),
(5, 1, 'NO', 'Nord', 'North'),
(6, 1, 'EN', 'Extrême-Nord', 'Far North'),
(7, 1, 'AD', 'Adamaoua', 'Adamawa'),
(8, 1, 'ES', 'Est', 'East'),
(9, 1, 'NW', 'Nord-Ouest', 'North West'),
(10, 1, 'SW', 'Sud-Ouest', 'South West');

-- Référentiels statiques CRM
CREATE TABLE IF NOT EXISTS crm_ref_institution_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO crm_ref_institution_types (id, code, name, name_en) VALUES
(1, 'PROSPECT', 'Prospect', 'Prospect'),
(2, 'ADMINISTRATION', 'Administration', 'Administration'),
(3, 'ENTERPRISE_PUBLIQUE', 'Entreprise Publique', 'Public Enterprise'),
(4, 'CTD', 'Collectivité Territoriale (CTD)', 'Decentralized Territorial Community');

CREATE TABLE IF NOT EXISTS crm_ref_influence_levels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO crm_ref_influence_levels (id, code, name, name_en) VALUES
(1, 'DECIDEUR', 'Décideur', 'Decision Maker'),
(2, 'PRESCRIPTEUR', 'Prescripteur', 'Advisor'),
(3, 'INFLUENCEUR', 'Influenceur', 'Influencer'),
(4, 'FACILITATEUR', 'Facilitateur', 'Facilitator');

CREATE TABLE IF NOT EXISTS crm_ref_priorities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO crm_ref_priorities (id, code, name, name_en) VALUES
(1, 'LOW', 'Faible', 'Low'),
(2, 'MEDIUM', 'Moyenne', 'Medium'),
(3, 'HIGH', 'Élevée', 'High');

CREATE TABLE IF NOT EXISTS crm_ref_mission_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO crm_ref_mission_types (id, code, name, name_en) VALUES
(1, 'PROSPECTION', 'Prospection', 'Prospection'),
(2, 'RELANCE', 'Relance', 'Follow-up'),
(3, 'NEGOCIATION', 'Négociation', 'Negotiation'),
(4, 'SIGNATURE', 'Signature', 'Signature'),
(5, 'SUIVI', 'Suivi', 'Monitoring'),
(6, 'AUTRE', 'Autre', 'Other');

CREATE TABLE IF NOT EXISTS crm_ref_period_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO crm_ref_period_types (id, code, name, name_en) VALUES
(1, 'ANNUAL', 'Annuel', 'Annual'),
(2, 'SEMESTRIAL', 'Semestriel', 'Semestrial'),
(3, 'TRIMESTRIAL', 'Trimestriel', 'Trimestrial'),
(4, 'MONTHLY', 'Mensuel', 'Monthly'),
(5, 'EXCEPTIONAL', 'Exceptionnel', 'Exceptional');

INSERT IGNORE INTO crm_ref_departments (id, region_id, code, name, name_en) VALUES
(1, 1, 'MEFOU', 'Mefou-et-Afamba', 'Mefou-et-Afamba'),
(2, 1, 'MFOUNDI', 'Mfoundi', 'Mfoundi'),
(3, 2, 'WOURI', 'Wouri', 'Wouri'),
(4, 3, 'MIFI', 'Mifi', 'Mifi'),
(5, 4, 'MVILA', 'Mvila', 'Mvila'),
(6, 5, 'BENOUE', 'Bénoué', 'Benoue'),
(7, 6, 'DIAMARE', 'Diamaré', 'Diamare'),
(8, 7, 'VINA', 'Vina', 'Vina'),
(9, 8, 'LOM_ET_DJEREM', 'Lom-et-Djérem', 'Lom-et-Djerem'),
(10, 9, 'MEZAM', 'Mezam', 'Mezam'),
(11, 10, 'FAKO', 'Fako', 'Fako');

INSERT IGNORE INTO crm_ref_cities (id, department_id, name, name_en) VALUES
(1, 2, 'Yaoundé', 'Yaounde'),
(2, 3, 'Douala', 'Douala'),
(3, 4, 'Bafoussam', 'Bafoussam'),
(4, 5, 'Ebolowa', 'Ebolowa'),
(5, 6, 'Garoua', 'Garoua'),
(6, 7, 'Maroua', 'Maroua'),
(7, 8, 'Ngaoundéré', 'Ngaoundere'),
(8, 9, 'Bertoua', 'Bertoua'),
(9, 10, 'Bamenda', 'Bamenda'),
(10, 11, 'Limbé', 'Limbe');

-- Utilisateurs par défaut (mot de passe : à hasher via script create_users.js)
-- Les mots de passe seront hashés à l'initialisation
INSERT IGNORE INTO users (id, username, password, full_name, first_name, last_name, role, job_description_id, is_verified) VALUES
(1, 'admin-crm',    '$2b$10$placeholder', 'Administrateur CRM',     'Admin',   'CRM',        'SYSTEM',    2, TRUE),
(2, 'dg-remontada', '$2b$10$placeholder', 'Directeur Remontada',    'Directeur','Remontada',  'DIRECTION', 1, TRUE),
(3, 'commercial-jr','$2b$10$placeholder', 'Commercial Junior Test', 'Junior',  'Commercial', 'COMMERCIAL',3, TRUE),
(4, 'commercial-sr','$2b$10$placeholder', 'Commercial Senior Test', 'Senior',  'Commercial', 'COMMERCIAL',4, TRUE);
