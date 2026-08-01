/**
 * Covers the SRV resolver bootstrap.
 *
 * The failure it exists for: Node's c-ares resolver fell back to `127.0.0.1`
 * while Windows itself had working nameservers, so `mongodb+srv://` lookups were
 * refused by a server that was never running — and startup blamed the database
 * for a DNS fault. @see config/dns.js
 */

const dns = require('dns');
const { srvNameFor, ensureSrvResolvable, FALLBACK_DNS_SERVERS } = require('../config/dns');

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

let resolveSrvSpy;
let setServersSpy;
let originalServers;

beforeEach(() => {
  originalServers = dns.getServers();
  resolveSrvSpy = jest.spyOn(dns.promises, 'resolveSrv');
  setServersSpy = jest.spyOn(dns, 'setServers').mockImplementation(() => {});
  jest.clearAllMocks();
});

afterEach(() => {
  resolveSrvSpy.mockRestore();
  setServersSpy.mockRestore();
});

afterAll(() => {
  // Never leave the process pointed somewhere the tests invented.
  dns.setServers(originalServers);
});

const failWith = (code) => Object.assign(new Error(code), { code });

describe('srvNameFor', () => {
  it('derives the SRV record from a credentialed URI', () => {
    expect(srvNameFor('mongodb+srv://user:p%40ss@cluster.abc.mongodb.net/MyDb?retryWrites=true'))
      .toBe('_mongodb._tcp.cluster.abc.mongodb.net');
  });

  it('handles a URI with no credentials and no database', () => {
    expect(srvNameFor('mongodb+srv://cluster.abc.mongodb.net'))
      .toBe('_mongodb._tcp.cluster.abc.mongodb.net');
  });

  it('returns null for a non-SRV URI, which needs no lookup at all', () => {
    expect(srvNameFor('mongodb://localhost:27017/MyDb')).toBeNull();
  });
});

describe('ensureSrvResolvable', () => {
  const uri = 'mongodb+srv://u:p@cluster.abc.mongodb.net/Db';

  it('leaves a working resolver alone', async () => {
    resolveSrvSpy.mockResolvedValue([{ name: 'shard-00-00.abc.mongodb.net', port: 27017 }]);

    await expect(ensureSrvResolvable(uri, silentLogger)).resolves.toBe(true);
    expect(setServersSpy).not.toHaveBeenCalled();
  });

  it('skips the probe entirely for a non-SRV URI', async () => {
    await expect(ensureSrvResolvable('mongodb://localhost:27017/Db', silentLogger)).resolves.toBe(true);
    expect(resolveSrvSpy).not.toHaveBeenCalled();
  });

  it('falls back to public resolvers when the configured one refuses', async () => {
    // This is the observed failure exactly: c-ares pointed at 127.0.0.1 with
    // nothing listening there.
    resolveSrvSpy
      .mockRejectedValueOnce(failWith('ECONNREFUSED'))
      .mockResolvedValueOnce([{ name: 'shard-00-00.abc.mongodb.net', port: 27017 }]);

    await expect(ensureSrvResolvable(uri, silentLogger)).resolves.toBe(true);
    expect(setServersSpy).toHaveBeenCalledWith(FALLBACK_DNS_SERVERS);
  });

  it('honours DNS_SERVERS over the built-in fallback', async () => {
    process.env.DNS_SERVERS = '9.9.9.9, 149.112.112.112';
    resolveSrvSpy
      .mockRejectedValueOnce(failWith('ETIMEOUT'))
      .mockResolvedValueOnce([{ name: 'shard-00-00.abc.mongodb.net', port: 27017 }]);

    await ensureSrvResolvable(uri, silentLogger);

    expect(setServersSpy).toHaveBeenCalledWith(['9.9.9.9', '149.112.112.112']);
    delete process.env.DNS_SERVERS;
  });

  it('does NOT override the resolver when the record genuinely does not exist', async () => {
    // ENOTFOUND is a real answer. Swapping nameservers would not change it, and
    // doing so would mask a typo in the cluster hostname.
    resolveSrvSpy.mockRejectedValue(failWith('ENOTFOUND'));

    await expect(ensureSrvResolvable(uri, silentLogger)).resolves.toBe(false);
    expect(setServersSpy).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing when the fallback also fails', async () => {
    // Startup must still proceed to the connection attempt, which produces the
    // authoritative error.
    resolveSrvSpy.mockRejectedValue(failWith('ECONNREFUSED'));

    await expect(ensureSrvResolvable(uri, silentLogger)).resolves.toBe(false);
    expect(setServersSpy).toHaveBeenCalled();
  });
});
