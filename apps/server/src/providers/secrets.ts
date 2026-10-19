import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Encrypts API keys at rest with AES-256-GCM. The 32-byte master key lives next to the app database in a file only
 * the current user can read; the database holds ciphertext only, so a copied settings file does not leak keys.
 * (This protects against casual disclosure and backups, not against code running as the same user.)
 */
export class SecretBox {
  private key: Buffer;

  constructor(keyFile: string) {
    this.key = SecretBox.loadKey(keyFile);
  }

  private static loadKey(file: string): Buffer {
    try {
      const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
      if (k.length === 32) return k;
    } catch {
      /* create below */
    }
    const k = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
    return k;
  }

  /** `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  /** Returns null when the value was sealed with another key or has been tampered with. */
  open(sealed: string): string | null {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** Remove any occurrence of a secret from text bound for logs, errors or the browser. */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('••••');
  return out;
}
