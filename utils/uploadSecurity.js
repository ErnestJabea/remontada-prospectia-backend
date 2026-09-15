const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads');

function safeUploadPath(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  const resolved = path.resolve(storedPath);
  const relative = path.relative(UPLOAD_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function readHeader(filePath, length = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function hasValidSignature(file) {
  const filePath = safeUploadPath(file.path);
  if (!filePath || !fs.existsSync(filePath)) return false;

  const header = readHeader(filePath);
  const extension = path.extname(file.originalname || file.path).toLowerCase();

  if (extension === '.pdf') return header.subarray(0, 4).toString('ascii') === '%PDF';
  if (extension === '.png') return header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') {
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  }
  if (extension === '.docx' || extension === '.xlsx') {
    return header[0] === 0x50 && header[1] === 0x4b;
  }

  return false;
}

function validateUploadedFilesContent(files = []) {
  return files.every(hasValidSignature);
}

function deleteStoredUpload(storedPath) {
  const filePath = safeUploadPath(storedPath);
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function sendStoredUpload(res, storedPath, downloadName) {
  const filePath = safeUploadPath(storedPath);
  if (!filePath || !fs.existsSync(filePath)) return false;
  res.download(path.relative(UPLOAD_ROOT, filePath), downloadName, {root:UPLOAD_ROOT});
  return true;
}

module.exports = {
  deleteStoredUpload,
  safeUploadPath,
  sendStoredUpload,
  validateUploadedFilesContent
};
