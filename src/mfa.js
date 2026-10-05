// Tweestapsverificatie: TOTP (RFC 6238, 30 seconden, 6 cijfers, SHA-1) zoals authenticator-apps gebruiken,
// plus versleutelde opslag van de geheime sleutel en eenmalige herstelcodes.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = h.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const STEP = 30;
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Geeft de gebruikte tijdstap terug bij een geldige code, anders null.
// Eén stap speling naar beide kanten (klokverschil); codes van een eerder gebruikte stap worden geweigerd.
function verifyTotp(secretB32, code, lastStep = null, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const step = currentStep(now);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (lastStep !== null && lastStep !== undefined && s <= lastStep) continue;
    if (safeEqual(hotp(key, s), c)) return s;
  }
  return null;
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function otpauthUrl(secret, account, issuer = 'Coretic uren') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

// AES-256-GCM met een sleutel uit APP_SECRET (val terug op een afgeleide van DATABASE_URL).
let warned = false;
function key() {
  if (!process.env.APP_SECRET && !warned) {
    console.warn('APP_SECRET is niet ingesteld; zet een lange willekeurige waarde in de omgevingsvariabelen.');
    warned = true;
  }
  return crypto.createHash('sha256').update(process.env.APP_SECRET || `coretic-uren:${process.env.DATABASE_URL}`).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob || '').split(':');
  if (v !== 'v1') throw new Error('Onbekend formaat');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// Herstelcodes: 8 stuks "xxxxx-xxxxx", opgeslagen als sha256-hash.
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
function newRecoveryCodes(n = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

module.exports = {
  base32Encode, base32Decode, hotp, verifyTotp, newSecret, otpauthUrl, encrypt, decrypt,
  hashCode, newRecoveryCodes, currentStep,
};
