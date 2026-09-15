const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465;
const SMTP_FROM = process.env.SMTP_FROM || '"Remontada Prospectia" <no-reply@remontada.cm>';
const LOG_DEV_OTP = process.env.NODE_ENV !== 'production' && process.env.LOG_DEV_OTP === 'true';

const isConfigured = Boolean(
  SMTP_HOST &&
  SMTP_USER &&
  SMTP_PASSWORD &&
  !SMTP_USER.includes('votre-email') &&
  !SMTP_USER.includes('votre-mot-de-passe')
);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== 'true'
      }
    })
  : null;

function logDevelopmentOtp(username, otp) {
  if (LOG_DEV_OTP) {
    console.log(`[MFA] [DEV ONLY] OTP pour ${username}: ${otp}`);
  }
}

async function sendOTPEmail(to, username, otp) {
  logDevelopmentOtp(username, otp);
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 28px;">
      <h2 style="color: #e31e24;">Remontada Prospectia</h2>
      <p>Bonjour <strong>${username}</strong>,</p>
      <p>Votre code de securite temporaire est :</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${otp}</p>
      <p>Ce code est valable pendant 10 minutes. Ne le communiquez a personne.</p>
    </div>
  `;

  if (!transporter) {
    console.log(`[MFA] Envoi email simule vers ${to}.`);
    logDevelopmentOtp(username, otp);
    return true;
  }

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject: 'Votre code de securite Remontada Prospectia',
      html: emailBody,
      text: `Bonjour ${username}, votre code de securite est ${otp}. Il est valable pendant 10 minutes.`
    });
    console.log(`[MAIL] Code MFA envoye a ${to}.`);
    return true;
  } catch (err) {
    console.error(`[MAIL] Echec de l'envoi a ${to}:`, err.message);
    logDevelopmentOtp(username, otp);
    return false;
  }
}

async function sendPasswordResetEmail(to, username, otp) {
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 28px;">
      <h2 style="color: #e31e24;">Reinitialisation du mot de passe</h2>
      <p>Bonjour <strong>${username}</strong>,</p>
      <p>Utilisez le code suivant pour definir un nouveau mot de passe :</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${otp}</p>
      <p>Ce code est valable pendant 10 minutes et ne peut etre utilise qu'une fois.</p>
      <p>Si vous n'avez pas demande cette operation, ignorez cet email.</p>
    </div>
  `;

  if (!transporter) {
    console.log(`[PASSWORD_RESET] Envoi email simule vers ${to}.`);
    logDevelopmentOtp(username, otp);
    return true;
  }

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject: 'Reinitialisation de votre mot de passe Remontada Prospectia',
      html: emailBody,
      text: `Bonjour ${username}, votre code de reinitialisation est ${otp}. Il est valable pendant 10 minutes.`
    });
    console.log(`[MAIL] Code de reinitialisation envoye a ${to}.`);
    return true;
  } catch (err) {
    console.error(`[MAIL] Echec de l'envoi a ${to}:`, err.message);
    logDevelopmentOtp(username, otp);
    return false;
  }
}

async function sendInitialPasswordSetupEmail(to, user) {
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: auto; padding: 28px;">
      <h2 style="color: #e31e24;">Bienvenue sur Remontada Prospectia</h2>
      <p>Bonjour <strong>${user.fullName || user.username}</strong>,</p>
      <p>Votre compte a ete cree.</p>
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin: 18px 0;">
        <p style="margin: 0 0 8px;"><strong>Identifiant :</strong> ${user.username}</p>
        <p style="margin: 0 0 8px;"><strong>Code de creation du mot de passe :</strong> ${user.otp}</p>
        <p style="margin: 0;"><a href="${user.setupUrl}" style="color: #e31e24; font-weight: bold;">Definir mon mot de passe</a></p>
      </div>
      <p>Ce lien et ce code sont temporaires et ne peuvent etre utilises qu'une seule fois.</p>
      <p>Ne transferez pas cet email et ne communiquez jamais ce code.</p>
    </div>
  `;

  if (!transporter) {
    console.error('[MAIL] SMTP non configure. Invitation de creation de mot de passe non envoyee.');
    return false;
  }

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject: 'Vos acces Remontada Prospectia',
      html: emailBody,
      text: `Bonjour ${user.fullName || user.username}, votre compte a ete cree. Identifiant: ${user.username}. Definissez votre mot de passe avec ce lien: ${user.setupUrl}. Code: ${user.otp}.`
    });
    console.log(`[MAIL] Invitation de creation de mot de passe envoyee a ${to}.`);
    return true;
  } catch (err) {
    console.error(`[MAIL] Echec de l'envoi de l'invitation a ${to}:`, err.message);
    return false;
  }
}

module.exports = { sendOTPEmail, sendPasswordResetEmail, sendInitialPasswordSetupEmail };
