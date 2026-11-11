import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** D13: one onboarded trading partner, from config/partners.json. */
export interface Partner {
  /** Also the SFTP username. Uppercase letters and digits, 2-32 chars. */
  readonly id: string;
  readonly name: string;
  /** OpenSSH public keys. Private keys never enter the repo (D23). */
  readonly sshPublicKeys: readonly string[];
  /** Optional IPv4/IPv6 addresses or CIDRs. Empty means any source IP. */
  readonly sourceIps: readonly string[];
}

export const PARTNER_ID_PATTERN = /^[A-Z0-9]{2,32}$/;
const SSH_KEY_PATTERN =
  /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [^\s]+)?$/;
const IP_OR_CIDR_PATTERN = /^([0-9.]+|[0-9a-fA-F:]+)(\/\d{1,3})?$/;

export const DEFAULT_PARTNERS_FILE = join(__dirname, '..', 'config', 'partners.json');

/** Parses and validates partner config. Throws with every problem found. */
export function parsePartners(raw: unknown): Partner[] {
  const errors: string[] = [];
  const list = (raw as { partners?: unknown })?.partners;
  if (!Array.isArray(list)) {
    throw new Error('partners.json: "partners" must be an array');
  }
  const seen = new Set<string>();
  const partners = list.map((p: Record<string, unknown>, i): Partner => {
    const where = `partners[${i}]`;
    const id = p.id;
    if (typeof id !== 'string' || !PARTNER_ID_PATTERN.test(id)) {
      errors.push(`${where}.id must match ${PARTNER_ID_PATTERN}`);
    } else if (seen.has(id)) {
      errors.push(`${where}.id "${id}" is duplicated`);
    } else {
      seen.add(id);
    }
    if (typeof p.name !== 'string' || p.name.trim() === '') {
      errors.push(`${where}.name is required`);
    }
    const keys = Array.isArray(p.sshPublicKeys) ? p.sshPublicKeys : [];
    if (keys.length === 0) {
      errors.push(`${where}.sshPublicKeys needs at least one key (SSH-key auth only, D4)`);
    }
    keys.forEach((k, j) => {
      if (typeof k !== 'string' || !SSH_KEY_PATTERN.test(k.trim())) {
        errors.push(`${where}.sshPublicKeys[${j}] is not an OpenSSH public key`);
      }
    });
    const ips = Array.isArray(p.sourceIps) ? p.sourceIps : [];
    ips.forEach((ip, j) => {
      if (typeof ip !== 'string' || !IP_OR_CIDR_PATTERN.test(ip)) {
        errors.push(`${where}.sourceIps[${j}] is not an IP address or CIDR`);
      }
    });
    return {
      id: String(id),
      name: String(p.name),
      sshPublicKeys: keys.map((k) => String(k).trim()),
      sourceIps: ips.map(String),
    };
  });
  if (errors.length > 0) {
    throw new Error(`Invalid partner config:\n  ${errors.join('\n  ')}`);
  }
  return partners;
}

export function loadPartners(file: string = DEFAULT_PARTNERS_FILE): Partner[] {
  return parsePartners(JSON.parse(readFileSync(file, 'utf8')));
}
