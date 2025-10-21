import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import crypto from 'crypto';
import axios from 'axios';
import { GoogleAIFileManager } from '@google/generative-ai/server';

const INLINE_LIMIT_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
const INLINE_LIMIT_TEXT_BYTES = 1 * 1024 * 1024; // 1MB

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.xml',
  '.log',
  '.yaml',
  '.yml'
]);

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.log': 'text/plain',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml'
};

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeMimeType(name = '', mimeType = '') {
  if (mimeType) {
    return mimeType;
  }
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXTENSION[ext] || '';
}

function isImageAttachment(name = '', mimeType = '') {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return true;
  }
  if (mimeType?.startsWith('image/')) {
    return true;
  }
  return false;
}

function isTextLikeAttachment(name = '', mimeType = '') {
  if (mimeType?.startsWith('text/')) {
    return true;
  }
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTS.has(ext)) {
    return true;
  }
  if (mimeType === 'application/json' || mimeType === 'application/xml') {
    return true;
  }
  return false;
}

export function parseDiscordAttachments(message) {
  const images = [];
  const files = [];
  if (message?.attachments?.size) {
    for (const attachment of message.attachments.values()) {
      const name = attachment.name || '';
      const size = typeof attachment.size === 'number' ? attachment.size : 0;
      const providedMime = attachment.contentType || '';
      const mimeType = normalizeMimeType(name, providedMime);
      const item = {
        url: attachment.url,
        name,
        size,
        mimeType
      };
      if (isImageAttachment(name, mimeType)) {
        images.push(item);
      } else {
        files.push(item);
      }
    }
  }
  return {
    images,
    files,
    hasImages: images.length > 0,
    hasFiles: files.length > 0
  };
}

export async function fetchAsBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 50 * 1024 * 1024
      });
      return Buffer.from(response.data);
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_ATTEMPTS) {
        await wait(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

export function toBase64(buffer) {
  return buffer.toString('base64');
}

export function maybeInlineImage({ buffer, mimeType, size }) {
  if (!mimeType?.startsWith('image/')) {
    return null;
  }
  const actualSize = typeof size === 'number' && size > 0 ? size : buffer.length;
  if (actualSize > INLINE_LIMIT_IMAGE_BYTES) {
    return null;
  }
  return {
    inlineData: {
      mimeType,
      data: toBase64(buffer)
    }
  };
}

function generateTempFilePath(name) {
  const safeName = name || `upload-${crypto.randomBytes(6).toString('hex')}`;
  return safeName.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export async function uploadToGeminiFileAPI({ buffer, mimeType, name, apiKey }) {
  if (!apiKey) {
    throw new Error('Missing Gemini API key for file upload.');
  }
  const manager = new GoogleAIFileManager(apiKey);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-upload-'));
  const fileName = generateTempFilePath(name);
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, buffer);
  try {
    const uploadResponse = await manager.uploadFile(filePath, {
      mimeType: mimeType || 'application/octet-stream',
      displayName: name || fileName
    });
    const uploadedFile = uploadResponse?.file ?? uploadResponse;
    const fileUri = uploadedFile?.uri || uploadedFile?.fileUri || uploadedFile?.name;
    if (!fileUri) {
      throw new Error('Upload response did not include a file URI.');
    }
    return {
      fileData: {
        fileUri,
        mimeType: mimeType || uploadedFile?.mimeType || 'application/octet-stream'
      }
    };
  } finally {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[ATTACHMENTS] Failed to remove temp file:', error.message);
      }
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[ATTACHMENTS] Failed to remove temp directory:', error.message);
      }
    }
  }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown size';
  }
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value < 10 && exponent > 0 ? 1 : 0)} ${units[exponent]}`;
}

export async function buildGeminiParts({ text, images = [], files = [], apiKey }) {
  const parts = [];
  const safeText = typeof text === 'string' ? text : '';
  if (safeText.trim().length > 0) {
    parts.push({ text: safeText });
  }

  for (const image of images) {
    try {
      const buffer = await fetchAsBuffer(image.url);
      const mimeType = image.mimeType || normalizeMimeType(image.name);
      const inlinePart = maybeInlineImage({
        buffer,
        mimeType: mimeType || 'image/png',
        size: image.size
      });
      if (inlinePart) {
        parts.push(inlinePart);
      } else {
        const uploadedPart = await uploadToGeminiFileAPI({
          buffer,
          mimeType: mimeType || 'application/octet-stream',
          name: image.name,
          apiKey
        });
        parts.push(uploadedPart);
      }
    } catch (error) {
      console.warn('[ATTACHMENTS] Image handling error:', error?.message || error);
      const label = image.name || 'image attachment';
      parts.push({ text: `Attached image could not be processed (${label}).` });
    }
  }

  for (const file of files) {
    try {
      const buffer = await fetchAsBuffer(file.url);
      const size = buffer.length;
      const mimeType = file.mimeType || normalizeMimeType(file.name) || 'application/octet-stream';
      const label = file.name || 'file attachment';
      const descriptor = `${label} (${mimeType}, ${formatSize(size)})`;
      parts.push({ text: `Attached file: ${descriptor}.` });

      const isText = isTextLikeAttachment(file.name, mimeType);
      if (isText && size <= INLINE_LIMIT_TEXT_BYTES) {
        try {
          const textContent = buffer.toString('utf8');
          parts.push({ text: `Contents of ${label} (truncated to ${INLINE_LIMIT_TEXT_BYTES} bytes if necessary):\n\n${textContent}` });
        } catch (convertError) {
          console.warn('[ATTACHMENTS] Failed to inline text content:', convertError?.message || convertError);
        }
      }

      if (apiKey) {
        const uploadedPart = await uploadToGeminiFileAPI({
          buffer,
          mimeType,
          name: label,
          apiKey
        });
        parts.push(uploadedPart);
      } else {
        console.warn('[ATTACHMENTS] Gemini API key missing; file upload skipped for', label);
      }
    } catch (error) {
      console.warn('[ATTACHMENTS] File handling error:', error?.message || error);
      const label = file.name || 'file attachment';
      parts.push({ text: `Attached file received but preview unavailable: ${label} (${file.mimeType || 'unknown type'}).` });
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '' });
  }

  return parts;
}

export const limits = {
  INLINE_LIMIT_IMAGE_BYTES,
  INLINE_LIMIT_TEXT_BYTES
};
