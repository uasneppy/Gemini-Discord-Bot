import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import crypto from 'crypto';
import axios from 'axios';
import { GoogleAIFileManager } from '@google/generative-ai/server';

const INLINE_LIMIT_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB legacy limit (kept for compatibility)
const INLINE_LIMIT_TEXT_BYTES = 1 * 1024 * 1024; // 1MB

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.heic']);
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
  '.tif': 'image/tiff',
  '.heic': 'image/heic',
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

function extToMime(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    case 'tif':
    case 'tiff': return 'image/tiff';
    case 'heic': return 'image/heic';
    default: return MIME_BY_EXTENSION[`.${ext}`] || 'application/octet-stream';
  }
}

export function classifyDiscordAttachment(attachment = {}) {
  const name = attachment.name || '';
  const providedMime = typeof attachment.contentType === 'string' ? attachment.contentType : '';
  const extMatch = /(\.[^./\\]+)$/i.exec(name || '') || [];
  const ext = extMatch[1] ? extMatch[1].toLowerCase() : '';
  const hasMime = providedMime.startsWith('image/');
  const hasExt = IMAGE_EXTS.has(ext);
  const hasDimensions = Number.isFinite(attachment.width) && Number.isFinite(attachment.height);
  const isImage = hasMime || hasExt || hasDimensions;

  const mimeType = providedMime
    || (hasExt ? extToMime(name)
      : hasDimensions ? 'image/png'
        : MIME_BY_EXTENSION[ext] || 'application/octet-stream');

  const size = Number.isFinite(attachment.size) ? attachment.size : null;
  const url = attachment.url || attachment.proxyURL || null;

  return {
    isImage,
    mimeType,
    name,
    size,
    url,
    width: Number.isFinite(attachment.width) ? attachment.width : null,
    height: Number.isFinite(attachment.height) ? attachment.height : null
  };
}

function normalizeMimeType(name = '', mimeType = '') {
  if (mimeType) {
    return mimeType;
  }
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
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
  const attachments = message?.attachments;
  if (!attachments) {
    return {
      images,
      files,
      hasImages: false,
      hasFiles: false
    };
  }

  const iterator = typeof attachments.values === 'function'
    ? attachments.values()
    : Array.isArray(attachments)
      ? attachments
      : [];

  for (const raw of iterator) {
    const classified = classifyDiscordAttachment(raw);
    if (!classified.url) {
      continue;
    }
    const normalized = {
      url: classified.url,
      name: classified.name,
      size: classified.size,
      mimeType: classified.mimeType,
      width: classified.width,
      height: classified.height
    };
    if (classified.isImage) {
      images.push(normalized);
    } else {
      files.push(normalized);
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

function maybeInlineImage({ buffer, mimeType, size, maxInlineSize }) {
  if (!mimeType?.startsWith('image/')) {
    return null;
  }
  const actualSize = Number.isFinite(size) && size > 0 ? size : buffer.length;
  if (actualSize > maxInlineSize) {
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
    const fileHandle = uploadedFile?.name || uploadedFile?.uri || uploadedFile?.fileUri;
    if (!fileHandle) {
      throw new Error('Upload response did not include a file URI.');
    }
    return {
      fileData: {
        fileUri: fileHandle,
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

export async function buildGeminiParts({
  text,
  images = [],
  files = [],
  apiKey,
  maxInlineSize = 4_000_000
}) {
  const parts = [];
  const safeText = typeof text === 'string' ? text : '';
  parts.push({ text: safeText });

  if (!apiKey) {
    console.warn('[ATTACHMENTS] No Gemini apiKey: uploads will be skipped.');
  }

  for (const image of images) {
    if (!image?.url) {
      continue;
    }
    try {
      const buffer = await fetchAsBuffer(image.url);
      const mimeType = image.mimeType || normalizeMimeType(image.name, image.mimeType) || 'image/png';
      const inlinePart = maybeInlineImage({
        buffer,
        mimeType,
        size: image.size,
        maxInlineSize
      });
      if (inlinePart) {
        parts.push(inlinePart);
        continue;
      }

      if (!apiKey) {
        console.warn('[ATTACHMENTS] Image exceeds inline limit and no upload path available.', {
          name: image.name,
          size: image.size || buffer.length
        });
        parts.push({ text: `Attached image ${image.name || ''} (${mimeType}) was too large to inline and could not be uploaded.` });
        continue;
      }

      const uploadedPart = await uploadToGeminiFileAPI({
        buffer,
        mimeType: mimeType || 'application/octet-stream',
        name: image.name,
        apiKey
      });
      parts.push(uploadedPart);
    } catch (error) {
      console.warn('[ATTACHMENTS] Image handling error:', error?.message || error);
      const label = image.name || 'image attachment';
      parts.push({ text: `Attached image could not be processed (${label}).` });
    }
  }

  for (const file of files) {
    if (!file?.url) {
      continue;
    }
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
