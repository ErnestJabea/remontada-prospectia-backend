/**
 * Migration script to make the ERP Remontada Prospectia bilingual.
 * Adds name_en to all referential tables and seeds Cameroon's 10 regions, 58 departments, and all arrondissements.
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// Create pool manually to ensure we are using the correct database
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'nexus_crm',
  waitForConnections: true,
  connectionLimit: 5
});

const tables = [
  'crm_ref_countries',
  'crm_ref_regions',
  'crm_ref_departments',
  'crm_ref_cities',
  'crm_ref_institution_types',
  'crm_ref_influence_levels',
  'crm_ref_priorities',
  'crm_ref_mission_types',
  'crm_ref_period_types'
];

async function addBilingualColumns() {
  console.log('--- Phase 1: Adding bilingual columns ---');
  for (const table of tables) {
    const [cols] = await pool.query(
      "SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [process.env.DB_NAME || 'nexus_crm', table, 'name_en']
    );
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN name_en VARCHAR(255) DEFAULT NULL`);
      console.log(`Added column 'name_en' to table '${table}'`);
    } else {
      console.log(`Column 'name_en' already exists in table '${table}'`);
    }
  }
}

async function seedStaticTranslations() {
  console.log('\n--- Phase 2: Seeding CRM static translations ---');

  const updates = {
    crm_ref_institution_types: [
      { code: 'PROSPECT', name: 'Prospect', name_en: 'Prospect' },
      { code: 'ADMINISTRATION', name: 'Administration', name_en: 'Administration' },
      { code: 'ENTERPRISE_PUBLIQUE', name: 'Entreprise Publique', name_en: 'Public Enterprise' },
      { code: 'CTD', name: 'Collectivité Territoriale Décentralisée', name_en: 'Decentralized Territorial Community' }
    ],
    crm_ref_influence_levels: [
      { code: 'DECIDEUR_PRINCIPAL', name: 'Décideur principal', name_en: 'Main Decision Maker' },
      { code: 'PRESCRIPTEUR_TECHNIQUE', name: 'Prescripteur technique', name_en: 'Technical Advisor' },
      { code: 'INFLUENCEUR', name: 'Influenceur', name_en: 'Influencer' },
      { code: 'AUTRE', name: 'Autre', name_en: 'Other' }
    ],
    crm_ref_priorities: [
      { code: 'HIGH', name: 'Élevée', name_en: 'High' },
      { code: 'MEDIUM', name: 'Moyenne', name_en: 'Medium' },
      { code: 'LOW', name: 'Faible', name_en: 'Low' }
    ],
    crm_ref_mission_types: [
      { code: 'PROSPECTION', name: 'Prospection', name_en: 'Prospection' },
      { code: 'SUIVI', name: 'Suivi commercial', name_en: 'Commercial Follow-up' },
      { code: 'NEGOCIATION', name: 'Négociation', name_en: 'Negotiation' },
      { code: 'INTELLIGENCE', name: 'Intelligence économique', name_en: 'Economic Intelligence' }
    ],
    crm_ref_period_types: [
      { code: 'MONTHLY', name: 'Mensuel', name_en: 'Monthly' },
      { code: 'QUARTERLY', name: 'Trimestriel', name_en: 'Quarterly' },
      { code: 'ANNUAL', name: 'Annuel', name_en: 'Annual' }
    ]
  };

  for (const [table, rows] of Object.entries(updates)) {
    for (const row of rows) {
      await pool.query(
        `UPDATE ${table} SET name = ?, name_en = ? WHERE code = ?`,
        [row.name, row.name_en, row.code]
      );
    }
    console.log(`Updated translations in table '${table}'`);
  }
}

async function seedCameroonGeographics() {
  console.log('\n--- Phase 3: Seeding Cameroon regions, departments, and cities ---');

  // 1. Ensure Cameroon exists
  const [countries] = await pool.query("SELECT id FROM crm_ref_countries WHERE code = 'CMR'");
  let countryId;
  if (countries.length === 0) {
    const [result] = await pool.query(
      "INSERT INTO crm_ref_countries (code, name, name_en) VALUES ('CMR', 'Cameroun', 'Cameroon')"
    );
    countryId = result.insertId;
  } else {
    countryId = countries[0].id;
    await pool.query("UPDATE crm_ref_countries SET name = 'Cameroun', name_en = 'Cameroon' WHERE id = ?", [countryId]);
  }
  console.log(`Cameroon country ID: ${countryId}`);

  // Cameroon geographics structure
  const data = [
    {
      code: 'ADAM', name: 'Adamaoua', name_en: 'Adamawa',
      departments: [
        { code: 'DJER', name: 'Djérem', name_en: 'Djerem', cities: ['Tibati', 'Ngaoundal'] },
        { code: 'FADE', name: 'Faro-et-Déo', name_en: 'Faro-et-Deo', cities: ['Tignère', 'Galim-Tignère', 'Mayo-Baléo', 'Kontcha'] },
        { code: 'MABA', name: 'Mayo-Banyo', name_en: 'Mayo-Banyo', cities: ['Banyo', 'Bankim', 'Mayo-Darlé'] },
        { code: 'MBER', name: 'Mbéré', name_en: 'Mbere', cities: ['Meiganga', 'Djohong', 'Dir', 'Ngaoui'] },
        { code: 'VINA', name: 'Vina', name_en: 'Vina', cities: ['Ngaoundéré I', 'Ngaoundéré II', 'Ngaoundéré III', 'Belel', 'Mvangan', 'Nganha', 'Martap'] }
      ]
    },
    {
      code: 'CENT', name: 'Centre', name_en: 'Center',
      departments: [
        { code: 'HASA', name: 'Haute-Sanaga', name_en: 'Haute-Sanaga', cities: ['Nanga-Eboko', 'Mbandjock', 'Lembe-Yezoum', 'Nsem', 'Bibey', 'Minta'] },
        { code: 'LEKI', name: 'Lekié', name_en: 'Lekie', cities: ['Monatélé', 'Obala', 'Evodoula', 'Okola', 'Sa\'a', 'Batchenga', 'Ebebda', 'Lobo', 'Elig-Mfomo'] },
        { code: 'MBIN', name: 'Mbam-et-Inoubou', name_en: 'Mbam-et-Inoubou', cities: ['Bafia', 'Ndikiniméki', 'Bokito', 'Deuk', 'Kon-Yambetta', 'Makénéné', 'Ombessa', 'Nitoukou'] },
        { code: 'MBKI', name: 'Mbam-et-Kim', name_en: 'Mbam-et-Kim', cities: ['Ntui', 'Mbangassina', 'Ngoro', 'Yoko', 'Ngambè-Tikar'] },
        { code: 'MEAF', name: 'Mefou-et-Afamba', name_en: 'Mefou-et-Afamba', cities: ['Mfou', 'Awaé', 'Soa', 'Afanloum', 'Esse', 'Olanguina'] },
        { code: 'MEAK', name: 'Mefou-et-Akono', name_en: 'Mefou-et-Akono', cities: ['Ngoumou', 'Akono', 'Bikok', 'Mbankomo'] },
        { code: 'MFOU', name: 'Mfoundi', name_en: 'Mfoundi', cities: ['Yaoundé I', 'Yaoundé II', 'Yaoundé III', 'Yaoundé IV', 'Yaoundé V', 'Yaoundé VI', 'Yaoundé VII'] },
        { code: 'NYKE', name: 'Nyong-et-Kéllé', name_en: 'Nyong-et-Kelle', cities: ['Eséka', 'Messondo', 'Biyouha', 'Bondjock', 'Dibang', 'Makak', 'Matomb', 'Ngog-Mapubi', 'Nguibassal'] },
        { code: 'NYMF', name: 'Nyong-et-Mfoumou', name_en: 'Nyong-et-Mfoumou', cities: ['Akonolinga', 'Ayos', 'Endom', 'Kobdombo', 'Mengang'] },
        { code: 'NYSO', name: 'Nyong-et-So\'o', name_en: 'Nyong-et-So\'o', cities: ['Mbalmayo', 'Akon', 'Dzeng', 'Ngomedzap', 'Mengueme'] }
      ]
    },
    {
      code: 'EAST', name: 'Est', name_en: 'East',
      departments: [
        { code: 'BONG', name: 'Boumba-et-Ngoko', name_en: 'Boumba-et-Ngoko', cities: ['Yokadouma', 'Gari-Gombo', 'Moloundou', 'Salapoumbé'] },
        { code: 'HANY', name: 'Haut-Nyong', name_en: 'Haut-Nyong', cities: ['Abong-Mbang', 'Doumé', 'Lomié', 'Messamena', 'Nguelemendouka', 'Dimako', 'Mindourou', 'Somalomo'] },
        { code: 'LODJ', name: 'Lom-et-Djerem', name_en: 'Lom-et-Djerem', cities: ['Bertoua I', 'Bertoua II', 'Belabo', 'Garoua-Boulaï', 'Diang', 'Betare-Oya', 'Mandjou', 'Ngoura'] },
        { code: 'KADE', name: 'Kadey', name_en: 'Kadey', cities: ['Batouri', 'Ndélélé', 'Kette', 'Ouli', 'Mbang', 'Kentzou'] }
      ]
    },
    {
      code: 'ENOR', name: 'Extrême-Nord', name_en: 'Far North',
      departments: [
        { code: 'DIAM', name: 'Diamaré', name_en: 'Diamare', cities: ['Maroua I', 'Maroua II', 'Maroua III', 'Bogo', 'Dargala', 'Gazawa', 'Meri', 'Ndoukoula', 'Petté'] },
        { code: 'LOCH', name: 'Logone-et-Chari', name_en: 'Logone-et-Chari', cities: ['Kousséri', 'Logone-Birni', 'Makary', 'Blangoua', 'Darak', 'Fotokol', 'Hile-Alifa', 'Goulfey', 'Waza'] },
        { code: 'MADA', name: 'Mayo-Danay', name_en: 'Mayo-Danay', cities: ['Yagoua', 'Guéré', 'Gobo', 'Kar-Hay', 'Kalfou', 'Wina', 'Tchatibali', 'Maga', 'Kai-Kai', 'Vélé'] },
        { code: 'MAKA', name: 'Mayo-Kani', name_en: 'Mayo-Kani', cities: ['Kaélé', 'Moutourwa', 'Mindif', 'Guidiguis', 'Moulvoudaye', 'Taïbongo'] },
        { code: 'MASA', name: 'Mayo-Sava', name_en: 'Mayo-Sava', cities: ['Mora', 'Kolofata', 'Tokombéré'] },
        { code: 'MATS', name: 'Mayo-Tsanaga', name_en: 'Mayo-Tsanaga', cities: ['Mokolo', 'Bourrha', 'Hina', 'Koza', 'Mogodé', 'Souled'] }
      ]
    },
    {
      code: 'LITT', name: 'Littoral', name_en: 'Littoral',
      departments: [
        { code: 'WOUR', name: 'Wouri', name_en: 'Wouri', cities: ['Douala I', 'Douala II', 'Douala III', 'Douala IV', 'Douala V', 'Douala VI', 'Manoka'] },
        { code: 'SAMA', name: 'Sanaga-Maritime', name_en: 'Sanaga-Maritime', cities: ['Édéa I', 'Édéa II', 'Dizangué', 'Mouanko', 'Ngambe', 'Ndom', 'Massock-Songloulou', 'Pouma', 'Dibamba'] },
        { code: 'MOUN', name: 'Moungo', name_en: 'Moungo', cities: ['Nkongsamba I', 'Nkongsamba II', 'Nkongsamba III', 'Melong', 'Manjo', 'Loum', 'Penja', 'Njombé', 'Mbanga', 'Dibombari'] },
        { code: 'NKAM', name: 'Nkam', name_en: 'Nkam', cities: ['Yabassi', 'Nkondjock', 'Yingui', 'Nord-Makombé'] }
      ]
    },
    {
      code: 'NORT', name: 'Nord', name_en: 'North',
      departments: [
        { code: 'BENO', name: 'Bénoué', name_en: 'Benoue', cities: ['Garoua I', 'Garoua II', 'Garoua III', 'Bibemi', 'Lagdo', 'Pitoa', 'Touroua', 'Demsa', 'Ngong', 'Basché'] },
        { code: 'FARO', name: 'Faro', name_en: 'Faro', cities: ['Poli', 'Beka'] },
        { code: 'MALO', name: 'Mayo-Louti', name_en: 'Mayo-Louti', cities: ['Guider', 'Figuil', 'Mayo-Oulo'] },
        { code: 'MARE', name: 'Mayo-Rey', name_en: 'Mayo-Rey', cities: ['Tcholliré', 'Touboro', 'Rey-Bouba', 'Madingring'] }
      ]
    },
    {
      code: 'NOUE', name: 'Nord-Ouest', name_en: 'North West',
      departments: [
        { code: 'BOYO', name: 'Boyo', name_en: 'Boyo', cities: ['Fundong', 'Belo', 'Njinikom', 'Bum'] },
        { code: 'BUI', name: 'Bui', name_en: 'Bui', cities: ['Kumbo', 'Jakiri', 'Oku', 'Noni', 'Mbiame', 'Elak-Oku'] },
        { code: 'DOMA', name: 'Donga-Mantung', name_en: 'Donga-Mantung', cities: ['Nkambé', 'Ndu', 'Misaje', 'Ako', 'Nwa'] },
        { code: 'MENC', name: 'Menchum', name_en: 'Menchum', cities: ['Wum', 'Benakuma', 'Zhoa', 'Fungom'] },
        { code: 'MEZA', name: 'Mezam', name_en: 'Mezam', cities: ['Bamenda I', 'Bamenda II', 'Bamenda III', 'Santa', 'Tubah', 'Bafut', 'Bali'] },
        { code: 'MOMO', name: 'Momo', name_en: 'Momo', cities: ['Mbengwi', 'Batibo', 'Widikum', 'Ngie', 'Njikwa'] },
        { code: 'NGKE', name: 'Ngo-Ketunjia', name_en: 'Ngo-Ketunjia', cities: ['Ndop', 'Babessi', 'Balikumbat'] }
      ]
    },
    {
      code: 'WEST', name: 'Ouest', name_en: 'West',
      departments: [
        { code: 'BAMB', name: 'Bamboutos', name_en: 'Bamboutos', cities: ['Mbouda', 'Galim', 'Batcham', 'Babadjou'] },
        { code: 'HANK', name: 'Haut-Nkam', name_en: 'Haut-Nkam', cities: ['Bafang', 'Bana', 'Bakou', 'Kékem', 'Banwa', 'Batchingou'] },
        { code: 'HAPL', name: 'Hauts-Plateaux', name_en: 'Hauts-Plateaux', cities: ['Baham', 'Bamendjou', 'Bangou', 'Bayangam'] },
        { code: 'MIFI', name: 'Mifi', name_en: 'Mifi', cities: ['Bafoussam I', 'Bafoussam II', 'Bafoussam III'] },
        { code: 'MENO', name: 'Menoua', name_en: 'Menoua', cities: ['Dschang', 'Nkong-Ni', 'Penka-Michel', 'Santchou', 'Fokoué', 'Fongo-Tongo'] },
        { code: 'NDEE', name: 'Ndé', name_en: 'Nde', cities: ['Bangangté', 'Bazou', 'Tonga', 'Bassamba'] },
        { code: 'NOUN', name: 'Noun', name_en: 'Noun', cities: ['Foumban', 'Foumbot', 'Massangam', 'Magba', 'Malentouen', 'Koutaba', 'Bangourain', 'Njimom', 'Ngassang'] },
        { code: 'KHKH', name: 'Khoung-Khi', name_en: 'Khoung-Khi', cities: ['Bandjoun', 'Bayangam', 'Demdeng'] }
      ]
    },
    {
      code: 'SOUT', name: 'Sud', name_en: 'South',
      departments: [
        { code: 'DJLO', name: 'Dja-et-Lobo', name_en: 'Dja-et-Lobo', cities: ['Sangmélima', 'Djoum', 'Oveng', 'Bengbis', 'Meyomessala', 'Meyomessi', 'Mintom', 'Zoétélé'] },
        { code: 'MVIL', name: 'Mvila', name_en: 'Mvila', cities: ['Ebolowa I', 'Ebolowa II', 'Biwong-Bane', 'Biwong-Bulu', 'Efoulan', 'Mvangan', 'Ngoulemakong'] },
        { code: 'OCEA', name: 'Océan', name_en: 'Ocean', cities: ['Kribi I', 'Kribi II', 'Campo', 'Lokoundjé', 'Lolodorf', 'Akom II', 'Bipindi', 'Mvengue'] },
        { code: 'VANT', name: 'Vallée-du-Ntem', name_en: 'Vallee-du-Ntem', cities: ['Ambam', 'Ma\'an', 'Olamze', 'Kyé-Ossi'] }
      ]
    },
    {
      code: 'SOUE', name: 'Sud-Ouest', name_en: 'South West',
      departments: [
        { code: 'FAKO', name: 'Fako', name_en: 'Fako', cities: ['Limbe I', 'Limbe II', 'Limbe III', 'Buea', 'Tiko', 'Muyuka', 'West Coast'] },
        { code: 'LEBI', name: 'Lebialem', name_en: 'Lebialem', cities: ['Menji', 'Alou', 'Wabane'] },
        { code: 'MANY', name: 'Manyu', name_en: 'Manyu', cities: ['Mamfe', 'Tinto', 'Akwaya', 'Eyumodjock'] },
        { code: 'MEME', name: 'Meme', name_en: 'Meme', cities: ['Kumba I', 'Kumba II', 'Kumba III', 'Mbonge', 'Konye'] },
        { code: 'NDIA', name: 'Ndian', name_en: 'Ndian', cities: ['Mundemba', 'Toko', 'Ekondo-Titi', 'Bamusso', 'Isanguele', 'Kombo-Abedimo', 'Kombo-Itindi'] },
        { code: 'KUMU', name: 'Kupe-Muanenguba', name_en: 'Kupe-Muanenguba', cities: ['Bangem', 'Tombel', 'Nguti'] }
      ]
    }
  ];

  for (const reg of data) {
    // Insert Region
    const [regions] = await pool.query("SELECT id FROM crm_ref_regions WHERE code = ?", [reg.code]);
    let regionId;
    if (regions.length === 0) {
      const [result] = await pool.query(
        "INSERT INTO crm_ref_regions (country_id, code, name, name_en) VALUES (?, ?, ?, ?)",
        [countryId, reg.code, reg.name, reg.name_en]
      );
      regionId = result.insertId;
    } else {
      regionId = regions[0].id;
      await pool.query(
        "UPDATE crm_ref_regions SET country_id = ?, name = ?, name_en = ? WHERE id = ?",
        [countryId, reg.name, reg.name_en, regionId]
      );
    }
    console.log(`Region: ${reg.name} (ID: ${regionId})`);

    // Insert Departments
    for (const dept of reg.departments) {
      const [depts] = await pool.query("SELECT id FROM crm_ref_departments WHERE code = ?", [dept.code]);
      let deptId;
      if (depts.length === 0) {
        const [result] = await pool.query(
          "INSERT INTO crm_ref_departments (region_id, code, name, name_en) VALUES (?, ?, ?, ?)",
          [regionId, dept.code, dept.name, dept.name_en]
        );
        deptId = result.insertId;
      } else {
        deptId = depts[0].id;
        await pool.query(
          "UPDATE crm_ref_departments SET region_id = ?, name = ?, name_en = ? WHERE id = ?",
          [regionId, dept.name, dept.name_en, deptId]
        );
      }

      // Insert Cities / Arrondissements
      for (const cityName of dept.cities) {
        const [existingCities] = await pool.query(
          "SELECT id FROM crm_ref_cities WHERE department_id = ? AND name = ?",
          [deptId, cityName]
        );
        if (existingCities.length === 0) {
          await pool.query(
            "INSERT INTO crm_ref_cities (department_id, name, name_en) VALUES (?, ?, ?)",
            [deptId, cityName, cityName]
          );
        } else {
          await pool.query(
            "UPDATE crm_ref_cities SET name_en = ? WHERE id = ?",
            [cityName, existingCities[0].id]
          );
        }
      }
    }
  }
}

async function run() {
  try {
    await addBilingualColumns();
    await seedStaticTranslations();
    await seedCameroonGeographics();
    console.log('\nMigration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await pool.end();
  }
}

run();
