import { promises as dns } from 'node:dns';
import net from 'node:net';

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8 | v) >>> 0;
  }
  return n;
};

const inV4Range = (ip: string, cidr: string): boolean => {
  const [base, bitsStr] = cidr.split('/');
  if (!base || !bitsStr) return false;
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
};

const PRIVATE_V4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '224.0.0.0/4'
];

const isPrivateV4 = (ip: string): boolean => {
  for (const cidr of PRIVATE_V4_RANGES) {
    if (inV4Range(ip, cidr)) return true;
  }
  return false;
};

const expandV6 = (ip: string): string | null => {
  if (!ip.includes(':')) return null;
  const trimmed = ip.replace(/^\[|\]$/g, '');
  const zoneStripped = trimmed.split('%')[0] ?? trimmed;
  const parts = zoneStripped.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const hasV4 = tail.length > 0 && tail[tail.length - 1]!.includes('.');
  let v4Tail: string[] = [];
  if (hasV4) {
    const last = tail.pop()!;
    const v4Int = ipv4ToInt(last);
    if (v4Int === null) return null;
    const hi = (v4Int >>> 16) & 0xffff;
    const lo = v4Int & 0xffff;
    v4Tail = [hi.toString(16), lo.toString(16)];
  }
  const groups = head.concat(tail, v4Tail);
  const explicitCount = groups.filter(g => g !== '').length;
  if (parts.length === 1) {
    if (explicitCount !== 8) return null;
    return groups.map(g => g.padStart(4, '0')).join(':');
  }
  const fillCount = 8 - explicitCount;
  if (fillCount < 0) return null;
  const filled: string[] = [];
  for (const g of head) filled.push(g);
  for (let i = 0; i < fillCount; i++) filled.push('0');
  for (const g of tail) filled.push(g);
  for (const g of v4Tail) filled.push(g);
  if (filled.length !== 8) return null;
  return filled.map(g => g.padStart(4, '0')).join(':');
};

const v6FirstGroup = (expanded: string): number => parseInt(expanded.split(':')[0] ?? '0', 16);

const isPrivateV6 = (ip: string): boolean => {
  const expanded = expandV6(ip);
  if (!expanded) return false;
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  const first = v6FirstGroup(expanded);
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if (expanded.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const groups = expanded.split(':');
    const hi = parseInt(groups[6] ?? '0', 16);
    const lo = parseInt(groups[7] ?? '0', 16);
    const a = (hi >>> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >>> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateV4(`${a}.${b}.${c}.${d}`);
  }
  return false;
};

const isPrivateAddress = (ip: string): boolean => {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
};

export const assertPublicHttpUrl = async (url: string): Promise<void> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL inválida');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Sólo http/https');
  }
  const rawHost = parsed.hostname;
  if (!rawHost) throw new Error('Host inválido');
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'ip6-localhost') {
    throw new Error('Host privado bloqueado');
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (isPrivateAddress(host)) {
      throw new Error('Host privado bloqueado');
    }
    return;
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: false });
  } catch {
    throw new Error('No se pudo resolver el host');
  }
  if (resolved.length === 0) throw new Error('No se pudo resolver el host');
  for (const entry of resolved) {
    if (isPrivateAddress(entry.address)) {
      throw new Error('Host privado bloqueado');
    }
  }
};
