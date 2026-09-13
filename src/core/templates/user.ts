// user.ts: user-created templates persisted in `localStorage`.
//
// Each entry is a `Template` object: `{ id, name, source: 'user', pdf (base64),
// thumbnail (data URL), createdAt }`. We keep the thumbnails inline so the
// gallery card can render synchronously on first paint.
//
// Private-mode browsers will throw on `localStorage.setItem`; we silently
// fall back to in-memory storage and log a warning so the UI can still
// show the template for the current session.
import { v4 as uuidv4 } from 'uuid';
import type { Template } from '../types';
import { toBase64, fromBase64 } from '../project/serialize';
import { renderPdfThumbnail } from './thumbnail';

const STORAGE_KEY = 'canva.userTemplates';

let memoryFallback: Template[] | null = null;

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function safeRead(): Template[] {
  if (!hasLocalStorage()) return memoryFallback ?? [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTemplate);
  } catch (err) {
    console.warn('[userTemplates] failed to read storage:', err);
    return memoryFallback ?? [];
  }
}

function safeWrite(list: Template[]): void {
  if (!hasLocalStorage()) {
    memoryFallback = list;
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[userTemplates] failed to write storage:', err);
    memoryFallback = list;
  }
}

function isValidTemplate(v: unknown): v is Template {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.pdf === 'string' &&
    typeof t.createdAt === 'string' &&
    t.source === 'user'
  );
}

export function loadUserTemplates(): Template[] {
  return safeRead();
}

export function saveUserTemplates(templates: Template[]): void {
  safeWrite(templates);
}

export interface AddUserTemplateOptions {
  /** Skip thumbnail generation (faster, used by tests). */
  skipThumbnail?: boolean;
}

/**
 * Build a new user template record from raw PDF bytes, persist it, and
 * return the resulting record. The thumbnail is generated asynchronously
 * by rendering page 1 with pdfjs.
 *
 * 注意:`pdfBytes` 在生成封面后仍会被 `toBase64` 读取,所以封面渲染不能
 * 消耗掉它。`renderPdfThumbnail` 内部走 `loadDocument`,而后者会给 pdfjs
 * 一份私有副本 —— 这正是曾经导致 "Cannot perform Construct on a detached
 * or out-of-bounds ArrayBuffer" 的根因(旧实现把同一个 buffer 交给 pdfjs,
 * 被 transfer 后再去 base64 编码)。
 */
export async function addUserTemplate(
  name: string,
  pdfBytes: Uint8Array,
  options: AddUserTemplateOptions = {}
): Promise<Template> {
  const thumbnail = options.skipThumbnail
    ? ''
    : await renderPdfThumbnail(pdfBytes);
  const tpl: Template = {
    id: uuidv4(),
    name,
    source: 'user',
    pdf: toBase64(pdfBytes),
    thumbnail: thumbnail || undefined,
    createdAt: new Date().toISOString(),
  };
  const all = safeRead();
  all.push(tpl);
  safeWrite(all);
  return tpl;
}

export function removeUserTemplate(id: string): void {
  const next = safeRead().filter((t) => t.id !== id);
  safeWrite(next);
}

export function getUserTemplate(id: string): Template | undefined {
  return safeRead().find((t) => t.id === id);
}

/** Decode a Template's base64 PDF back to bytes. */
export function userTemplateBytes(t: Template): Uint8Array {
  return fromBase64(t.pdf);
}