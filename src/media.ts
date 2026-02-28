import { mkdirSync, readdirSync, statSync, unlinkSync, createWriteStream } from 'fs';
import { resolve, basename } from 'path';
import { get } from 'https';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

export const UPLOADS_DIR = resolve(PROJECT_ROOT, 'workspace', 'uploads');

// Ensure uploads dir exists
mkdirSync(UPLOADS_DIR, { recursive: true });

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string
): Promise<string> {
  // Step 1: Get file path from Telegram
  const fileInfo = await fetchJson(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const filePath = fileInfo.result?.file_path;
  if (!filePath) throw new Error('Could not get file path from Telegram');

  // Step 2: Download
  const ext = basename(filePath).includes('.') ? '.' + basename(filePath).split('.').pop() : '';
  const safeName = originalFilename ? sanitizeFilename(originalFilename) : `file${ext}`;
  const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`);

  await downloadFile(`https://api.telegram.org/file/bot${botToken}/${filePath}`, localPath);
  return localPath;
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo attached: ${localPath}]`];
  if (caption) parts.push(caption);
  parts.push('Please analyze this image.');
  return parts.join('\n');
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  const parts = [`[Document attached: ${localPath}] (filename: ${filename})`];
  if (caption) parts.push(caption);
  parts.push('Please read and analyze this document.');
  return parts.join('\n');
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [`[Video attached: ${localPath}]`];
  if (caption) parts.push(caption);
  parts.push('Please analyze this video using the Gemini API with the GOOGLE_API_KEY from .env.');
  return parts.join('\n');
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const now = Date.now();
    const files = readdirSync(UPLOADS_DIR);
    let cleaned = 0;
    let totalBytes = 0;
    for (const file of files) {
      const filePath = resolve(UPLOADS_DIR, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        totalBytes += stat.size;
        unlinkSync(filePath);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      const mb = (totalBytes / 1024 / 1024).toFixed(2);
      logger.info({ cleaned, totalBytes, mb: `${mb} MB` }, `Media cleanup: removed ${cleaned} file(s) (${mb} MB)`);
    } else {
      logger.info({ scanned: files.length }, 'Media cleanup: nothing to remove');
    }
  } catch (err) {
    logger.debug({ err }, 'Upload cleanup error');
  }
}

function fetchJson(url: string): Promise<{ result?: { file_path?: string } }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}
