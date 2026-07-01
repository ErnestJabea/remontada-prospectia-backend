const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const pool = require('../db');

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function ensurePdfSpace(doc, minHeight = 100) {
  if (doc.y > 760 - minHeight) doc.addPage();
}

function addPdfSection(doc, title) {
  doc.moveDown(1.2);
  const y = doc.y;
  ensurePdfSpace(doc, 40);

  // Left vertical red accent bar
  doc.save();
  doc.rect(54, y, 4, 15).fill('#e31e24');
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0f172a').text(title.toUpperCase(), 64, y + 2);
  doc.y = y + 22;
}

function drawMetadataGrid(doc, fields) {
  const startX = 54;
  const colWidth = 240;
  const rowHeight = 20;
  doc.save();

  for (let i = 0; i < fields.length; i += 2) {
    const y = doc.y;
    ensurePdfSpace(doc, rowHeight + 4);

    const f1 = fields[i];
    const f2 = fields[i + 1];

    // Draw subtle horizontal separator line
    if (i > 0) {
      doc.moveTo(startX, y).lineTo(startX + colWidth * 2, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    }

    // Draw first field
    if (f1) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#64748b').text(f1.label, startX, y + 5, { width: 95 });
      doc.font('Helvetica').fontSize(8.5).fillColor('#0f172a').text(String(f1.value || '-'), startX + 100, y + 5, { width: 135 });
    }

    // Draw second field
    if (f2) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#64748b').text(f2.label, startX + colWidth + 5, y + 5, { width: 95 });
      doc.font('Helvetica').fontSize(8.5).fillColor('#0f172a').text(String(f2.value || '-'), startX + colWidth + 100, y + 5, { width: 135 });
    }

    doc.y = y + rowHeight;
  }

  doc.restore();
  doc.moveDown(0.5);
}

function drawContentBlock(doc, title, content) {
  if (!content || !content.trim()) return;
  ensurePdfSpace(doc, 50);

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text(title);
  doc.moveDown(0.2);

  const yStart = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#1e293b');

  // Indent text by 10 points
  doc.text(content, 64, yStart, { width: 477, align: 'justify' });
  const yEnd = doc.y;

  // Draw a nice grey vertical border line on the left side of the indented block
  doc.save();
  doc.moveTo(54, yStart - 2)
    .lineTo(54, yEnd + 2)
    .lineWidth(2)
    .strokeColor('#e2e8f0')
    .stroke();
  doc.restore();

  doc.y = yEnd + 10; // add margin below
}

class ReportPdfService {
  static async generatePdf(reportId) {
    // 1. Fetch report details
    const [rows] = await pool.query(
      `SELECT rp.*, 
              m.title AS mission_title, m.scheduled_date, m.duration_hours,
              o.title AS objective_title, 
              i.name AS institution_name, i.address AS institution_address,
              u.full_name AS commercial_name,
              submitted.full_name AS submitted_by_name,
              validated.full_name AS validated_by_name,
              r.name AS region_name, d.name AS department_name, c.name AS city_name
       FROM crm_reports rp
       LEFT JOIN crm_missions m ON rp.mission_id = m.id
       LEFT JOIN crm_objectives o ON rp.objective_id = o.id
       LEFT JOIN crm_institutions i ON rp.institution_id = i.id
       LEFT JOIN users u ON rp.commercial_id = u.id
       LEFT JOIN users submitted ON rp.submitted_by = submitted.id
       LEFT JOIN users validated ON rp.validated_by = validated.id
       LEFT JOIN crm_ref_regions r ON m.region_id = r.id
       LEFT JOIN crm_ref_departments d ON m.department_id = d.id
       LEFT JOIN crm_ref_cities c ON m.city_id = c.id
       WHERE rp.id = ?`,
      [reportId]
    );

    const report = rows[0];
    if (!report) throw new Error('Rapport introuvable.');

    // 2. Fetch linked opportunities
    const [opps] = await pool.query(
      `SELECT o.title, o.estimated_amount, o.priority, o.status, ro.relation_type
       FROM crm_report_opportunities ro
       JOIN crm_opportunities o ON ro.opportunity_id = o.id
       WHERE ro.activity_report_id = ?`,
      [reportId]
    );

    // 3. Ensure directories exist
    const pdfDir = path.join(__dirname, '..', 'uploads', 'reports', 'pdf');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

    const filename = `rapport-${report.code || reportId}.pdf`;
    const filePath = path.join(pdfDir, filename);

    // 4. Create PDF Document
    const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true, info: { Title: `Rapport d'activité ${report.code || ''}` } });
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    // Logos
    const incLogoPath = path.resolve(__dirname, '..', '..', 'backoffice', 'src', 'assets', 'logo-inc.png');
    const ippcLogoPath = path.resolve(__dirname, '..', '..', 'backoffice', 'src', 'assets', 'logo-ippc.jpeg');

    // Header Band
    doc.rect(0, 0, 595.28, 94).fill('#ffffff');
    doc.rect(0, 92, 595.28, 4).fill('#e31e24');

    if (fs.existsSync(incLogoPath)) {
      try { doc.image(incLogoPath, 54, 18, { fit: [72, 54] }); } catch (e) { /* ignore */ }
    }
    if (fs.existsSync(ippcLogoPath)) {
      try { doc.image(ippcLogoPath, 464, 18, { fit: [78, 54] }); } catch (e) { /* ignore */ }
    }

    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text('REMONTADA PROSPECTIA', 140, 24, { width: 315, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Rapport d\'Activité Commerciale', 140, 47, { width: 315, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(report.code || `RAPPORT #${reportId}`, 140, 64, { width: 315, align: 'center' });

    doc.fillColor('#e31e24').font('Helvetica-Bold').fontSize(20).text('RAPPORT D\'ACTIVITE', 54, 118, { align: 'center' });
    doc.moveDown(0.2);

    // Status text block (no background, colored font)
    const statusText = `Statut : ${report.status}`;
    const statusColor = (report.status === 'VALIDE' || report.status === 'VALIDATED') 
      ? '#047857' 
      : (['REJETE', 'REJECTED', 'CORRECTION_DEMANDEE'].includes(report.status) ? '#b91c1c' : '#d97706');
    doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(11).text(statusText.toUpperCase(), 54, 142, { align: 'center' });
    
    doc.y = 165;

    // Section: Identification
    addPdfSection(doc, 'Identification');
    drawMetadataGrid(doc, [
      { label: 'Code Rapport :', value: report.code },
      { label: 'Type :', value: report.report_type === 'mission_report' ? 'Mission' : 'Activité' },
      { label: 'Commercial :', value: report.commercial_name },
      { label: 'Créé le :', value: formatDateTime(report.created_at) },
      { label: 'Date début :', value: report.period_start ? formatDate(report.period_start) : '-' },
      { label: 'Date fin :', value: report.period_end ? formatDate(report.period_end) : '-' }
    ]);

    // Section: Mission (si rapport de mission)
    if (report.mission_id) {
      ensurePdfSpace(doc, 110);
      addPdfSection(doc, 'Rappel de la mission');
      drawMetadataGrid(doc, [
        { label: 'Mission :', value: report.mission_title },
        { label: 'Objectif lié :', value: report.objective_title },
        { label: 'Institution ciblée :', value: report.institution_name },
        { label: 'Date mission :', value: formatDate(report.scheduled_date) },
        { label: 'Zone :', value: `${report.city_name || '-'} / ${report.department_name || '-'} / ${report.region_name || '-'}` },
        { label: 'Durée :', value: `${report.duration_hours || 2} heure(s)` }
      ]);
    } else {
      ensurePdfSpace(doc, 80);
      addPdfSection(doc, 'Institution cible');
      drawMetadataGrid(doc, [
        { label: 'Nom Institution :', value: report.institution_name },
        { label: 'Adresse :', value: report.institution_address }
      ]);
    }

    // Section: Déroulement & Synthèse
    addPdfSection(doc, 'Déroulement & Synthèse');
    drawContentBlock(doc, 'Résumé exécutif', report.executive_summary);
    drawContentBlock(doc, 'Résultats obtenus', report.results);
    drawContentBlock(doc, 'Personnes rencontrées / Administrations visitées', report.persons_met || report.administrations_visited);

    // Section: Diagnostic & Constats
    if (report.diagnosis) {
      addPdfSection(doc, 'Diagnostic & Constats');
      drawContentBlock(doc, 'Analyse documentaire & terrain', report.diagnosis);
    }

    // Section: Difficultés
    if (report.difficulties) {
      addPdfSection(doc, 'Difficultés rencontrées');
      drawContentBlock(doc, 'Obstacles & contraintes', report.difficulties);
    }

    // Section: Recommandations & Prochaines étapes
    if (report.recommendations || report.next_steps) {
      addPdfSection(doc, 'Recommandations & Suites proposées');
      drawContentBlock(doc, 'Recommandations', report.recommendations);
      drawContentBlock(doc, 'Suites à donner / Actions de suivi', report.next_steps);
    }

    // Section: Opportunités
    if (opps.length > 0) {
      ensurePdfSpace(doc, 100);
      addPdfSection(doc, 'Opportunités détectées ou rattachées');
      opps.forEach(opp => {
        ensurePdfSpace(doc, 48);
        const y = doc.y;

        // Beautiful Opportunity card
        doc.save();
        doc.rect(54, y, 487, 38).fillAndStroke('#f8fafc', '#e2e8f0');
        doc.restore();

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text(opp.title, 64, y + 6, { width: 467 });
        doc.font('Helvetica').fontSize(7.5).fillColor('#475569')
          .text(`Lien: ${opp.relation_type.toUpperCase()}  |  Montant: ${Number(opp.estimated_amount).toLocaleString('fr-FR')} XAF  |  Priorité: ${opp.priority}  |  Statut: ${opp.status}`, 64, y + 21);

        doc.y = y + 46;
      });
    }

    // Section: Validation (GATE 2)
    ensurePdfSpace(doc, 130);
    addPdfSection(doc, 'Approbation & Suivi (GATE 2)');
    drawMetadataGrid(doc, [
      { label: 'Soumis par :', value: report.submitted_by_name },
      { label: 'Date soumission :', value: formatDateTime(report.submitted_at) },
      { label: 'Approuvé par :', value: report.validated_by_name },
      { label: 'Date approbation :', value: formatDateTime(report.validated_at) }
    ]);

    if (report.rejection_reason) {
      drawContentBlock(doc, 'Motif du rejet', report.rejection_reason);
    }
    if (report.correction_comment) {
      drawContentBlock(doc, 'Commentaire de correction demandée', report.correction_comment);
    }

    // Footer page numbers (uniform layout)
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i += 1) {
      doc.switchToPage(i);
      doc.save();
      doc.moveTo(54, 795).lineTo(541, 795).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
      doc.restore();
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text(`ERP Remontada Prospectia — Document confidentiel`, 54, 804, { align: 'left', width: 240 });
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text(`Page ${i + 1} / ${pageCount}`, 300, 804, { align: 'right', width: 241 });
    }

    doc.end();

    // Wait for the stream to finish writing
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const dbPath = `uploads/reports/pdf/${filename}`;
    await pool.query('UPDATE crm_reports SET pdf_path = ? WHERE id = ?', [dbPath, reportId]);

    return filePath;
  }
}

module.exports = ReportPdfService;
