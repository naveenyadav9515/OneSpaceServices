/**
 * DNS bootstrap for `mongodb+srv://` connection strings.
 *
 * An SRV connection string is the only part of this service that depends on
 * Node's own DNS resolver. Ordinary connections use `dns.lookup`, which defers
 * to the operating system; SRV records go through `dns.resolveSrv`, which uses
 * the c-ares resolver bundled with Node and its *own* server list.
 *
 * Those two lists can disagree. On Windows, c-ares sometimes fails to read the
 * adapter configuration and silently falls back to `127.0.0.1` — so every SRV
 * lookup is refused by a nameserver that was never running, while nslookup, the
 * browser, and every other program on the machine resolve names perfectly well.
 * The result is a startup that fails five times with `querySrv ECONNREFUSED` and
 * looks exactly like the database being unreachable.
 *
 * This module probes the real SRV name before connecting and, only if that probe
 * fails for a reason that points at the resolver rather than the record, retries
 * against known-good nameservers.
 */

const dns = require('dns');

/**
 * Used when the configured resolver cannot be reached. Cloudflare first, Google
 * second — two independent operators, so one being unreachable is not fatal.
 */
const FALLBACK_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

/**
 * Error codes that mean "the nameserver did not answer", as opposed to "the name
 * does not exist". Only these justify overriding the system configuration:
 * ENOTFOUND / ENODATA are real answers and must be reported honestly, because
 * substituting a different resolver would not change them.
 */
const RESOLVER_FAILURE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL', 'EREFUSED', 'ECANCELLED',
]);

/**
 * Extracts the SRV record name a `mongodb+srv://` URI will look up.
 * @param {string} uri
 * @returns {string|null} e.g. `_mongodb._tcp.cluster.example.mongodb.net`, or
 *   null when the URI is not SRV-based and needs no probe
 */
function srvNameFor(uri) {
  if (!uri || !uri.startsWith('mongodb+srv://')) return null;

  // Strip scheme, then credentials, then anything after the host.
  const withoutScheme = uri.slice('mongodb+srv://'.length);
  const afterCredentials = withoutScheme.includes('@')
    ? withoutScheme.slice(withoutScheme.indexOf('@') + 1)
    : withoutScheme;
  const host = afterCredentials.split(/[/?]/)[0];

  return host ? `_mongodb._tcp.${host}` : null;
}

/**
 * @param {string} srvName
 * @returns {Promise<{ok: true}|{ok: false, code: string}>}
 */
async function probeSrv(srvName) {
  try {
    await dns.promises.resolveSrv(srvName);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code || 'UNKNOWN' };
  }
}

/**
 * Makes sure the SRV record behind a connection string is resolvable, repointing
 * Node's resolver at working nameservers if — and only if — the configured one
 * is the thing that is broken.
 *
 * Never throws: a failure here is not worth blocking startup over, because the
 * connection attempt that follows produces the authoritative error anyway. The
 * value is in the diagnosis it logs.
 *
 * @param {string} uri MongoDB connection string
 * @param {{info: Function, warn: Function, error: Function}} logger
 * @returns {Promise<boolean>} whether SRV resolution works by the time we return
 */
async function ensureSrvResolvable(uri, logger) {
  const srvName = srvNameFor(uri);
  if (!srvName) return true; // Not an SRV URI — nothing to check.

  const first = await probeSrv(srvName);
  if (first.ok) return true;

  if (!RESOLVER_FAILURE_CODES.has(first.code)) {
    // The nameserver answered; the record genuinely is not there. Overriding the
    // resolver would only hide a real configuration problem.
    logger.error(`🌐 DNS: ${srvName} could not be resolved (${first.code}). Check the cluster hostname in MONGO_URI.`);
    return false;
  }

  const configured = dns.getServers();
  const override = process.env.DNS_SERVERS
    ? process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean)
    : FALLBACK_DNS_SERVERS;

  logger.warn(`🌐 DNS: resolver ${JSON.stringify(configured)} refused the SRV lookup (${first.code}). Retrying via ${override.join(', ')}.`);

  try {
    dns.setServers(override);
  } catch (err) {
    logger.error(`🌐 DNS: could not apply fallback nameservers: ${err.message}`);
    return false;
  }

  const second = await probeSrv(srvName);
  if (second.ok) {
    logger.info(`🌐 DNS: SRV lookup succeeded via ${override.join(', ')}. Using these nameservers for this process.`);
    return true;
  }

  logger.error(
    `🌐 DNS: SRV lookup still failing (${second.code}) after trying ${override.join(', ')}. ` +
    'This is a network/DNS problem, not a database one — the cluster may be fine. ' +
    'Set DNS_SERVERS to a reachable resolver, or use the non-SRV "mongodb://" seed-list URI, which needs no SRV lookup.'
  );
  return false;
}

module.exports = {
  FALLBACK_DNS_SERVERS,
  srvNameFor,
  ensureSrvResolvable,
};
