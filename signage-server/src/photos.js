// Serving the club's own photographs off the card.
//
// The pool is a plain directory: drop files in, and the next loop picks them up. No
// upload form, no accounts, no moderation queue — the brief rules all three out, and a
// folder is what the person who keeps the club's pictures already understands.
//
// The directory is read for its listing and the files are streamed out, so twelve photos
// and four hundred photos cost the same code and the same memory.
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isPhotoName } from './clubhouse.js';

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

/** Photo filenames in `dir`, sorted. Missing or unreadable directory = no photographs. */
export async function listPhotos(dir) {
  if (!dir) return [];
  try {
    const names = await readdir(dir);
    return names.filter(isPhotoName).sort();
  } catch {
    return [];
  }
}

export function contentType(name) {
  const dot = String(name).lastIndexOf('.');
  return TYPES[String(name).slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve one requested name inside `dir`, or null.
 *
 * The screen only ever asks for names this server listed, so anything else is either a
 * stale page or someone poking at the port. Both get null: the name has to be a plain
 * filename, and the resolved path has to still be inside the configured directory.
 */
export function resolvePhoto(dir, name) {
  if (!dir || !name) return null;
  const clean = String(name);
  if (clean.includes('/') || clean.includes('\\') || clean.includes('\0') || clean.startsWith('.')) return null;
  if (!isPhotoName(clean)) return null;
  const base = resolve(dir);
  const full = resolve(base, clean);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Stream one image file from disk. Cached hard: the wall asks for the same dozen all day,
 * and every answered-from-cache request is one the card does not read off its SD card.
 */
export async function sendImage(res, file) {
  if (!file) return false;
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  res.writeHead(200, {
    'content-type': contentType(file),
    'content-length': info.size,
    'cache-control': 'public, max-age=86400',
  });
  createReadStream(file).pipe(res);
  return true;
}

/** One photograph from the pool, by the name the page was given. */
export function sendPhoto(res, dir, name) {
  return sendImage(res, resolvePhoto(dir, name));
}
