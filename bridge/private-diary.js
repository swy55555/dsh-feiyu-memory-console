// 私密日记的密码与加密。
// 说明：这是“防随手翻/文件被单独拷走”的软加密；管理员仍能读桥接的密码本，
// 因为肥鱼需要在“她愿意说”的时候把密码告诉你。不是对抗本机管理员的方案。

import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function newPassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function derive(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, SCRYPT);
}

function digest(password, salt) {
  return crypto.createHash('sha256').update(derive(password, salt)).digest('hex');
}

export function createVault(markdown, password = newPassword(), now = Date.now()) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = derive(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(markdown || ''), 'utf8'), cipher.final()]);
  return {
    version: 1,
    createdAt: now,
    salt: salt.toString('base64'),
    hash: digest(password, salt),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    cipher: encrypted.toString('base64'),
  };
}

export function openVault(record, password) {
  if (!record || record.version !== 1) throw new Error('私密日记还没有初始化');
  const salt = Buffer.from(record.salt, 'base64');
  if (digest(password, salt) !== record.hash) throw new Error('密码不对');
  const key = derive(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function passwordMatches(record, password) {
  try {
    if (!record?.salt || !record?.hash) return false;
    const salt = Buffer.from(record.salt, 'base64');
    return digest(password, salt) === record.hash;
  } catch {
    return false;
  }
}

export function makePassword(length = 10) {
  return newPassword(length);
}
