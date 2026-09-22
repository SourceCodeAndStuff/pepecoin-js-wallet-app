// One-off check (not committed): validate real Pepecoin mainnet headers with the new consensus code.
import { DatabaseSync } from 'node:sqlite';
import { PepecoinPeer, PEP_ARCHIVE_PEERS, parseHeaders, MultiPeerManager } from './wallet/lib/pepenet-p2p.js';
import { validateHeaderChain, checkHeaderPow, PEP_CONSENSUS } from './wallet/lib/pepenet-pow.js';

const wire = hex => Buffer.from(hex, 'hex').reverse();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function connect() {
  for (const address of PEP_ARCHIVE_PEERS) {
    const peer = new PepecoinPeer({ ...address, timeoutMs: 8000 });
    peer.on('error', () => {});
    try { await peer.connect(); log('connected', address.host, 'height', peer.remoteStartHeight); return peer; } catch (e) { log('skip', address.host, e.message); }
  }
  throw new Error('no peer');
}
function page(peer, locator) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { peer.off('message', on); reject(new Error('headers timeout')); }, 30000);
    const on = m => { if (m.command !== 'headers') return; clearTimeout(t); peer.off('message', on); try { resolve(parseHeaders(m.payload)); } catch (e) { reject(e); } };
    peer.on('message', on); peer.requestHeaders([locator]);
  });
}
// Validate `pages` pages following `startHash` at `startHeight`. The first two headers seed the
// difficulty/median-time context when the caller has none (PoW is still checked for them).
async function segment(peer, name, startHash, startHeight, pages, context = null) {
  let hash = startHash, ctx = context, count = 0, height = startHeight;
  for (let i = 0; i < pages; i++) {
    const headers = await page(peer, hash);
    if (!headers.length) break;
    let prev = hash;
    for (const h of headers) { if (!h.previousHash.equals(prev)) throw new Error(`${name}: linkage broken near ${height}`); prev = h.hash; }
    let rest = headers;
    if (!ctx) {
      const seed = headers.slice(0, 11);
      seed.forEach((h, k) => checkHeaderPow(h, height + k + 1));
      ctx = { height: height + seed.length, recent: seed.map(h => ({ time: h.time, bits: h.bits })) };
      rest = headers.slice(seed.length);
    }
    ctx = validateHeaderChain(rest, ctx);
    count += headers.length; height += headers.length; hash = headers.at(-1).hash;
    if (i % 5 === 4) log(name, 'validated through', height);
  }
  log(`${name}: OK — ${count} real headers validated (heights ${startHeight + 1}..${height})`);
  return { hash, height };
}

const peer = await connect();
const results = [];
try {
  // Genesis → 46,000 covers the pre-DigiShield window, the 40,477 checkpoint and AuxPoW activation at 42,000.
  results.push(await segment(peer, 'genesis', wire(PEP_CONSENSUS.genesis.hash), 0, 23, { height: 0, recent: [{ time: PEP_CONSENSUS.genesis.time, bits: PEP_CONSENSUS.genesis.bits }] }));
  results.push(await segment(peer, 'checkpoint-327239', wire(PEP_CONSENSUS.checkpoints.get(327239)), 327239, 3));
  const db = new DatabaseSync(process.argv[2] || './data/chainindex.db', { readOnly: true });
  const tip = db.prepare('SELECT MAX(height) AS h FROM blocks').get().h;
  const start = db.prepare('SELECT hash FROM blocks WHERE height=?').get(tip - 5000);
  db.close();
  log('local index tip', tip);
  const recent = await segment(peer, 'recent', wire(start.hash), tip - 5000, 10);
  const manager = new MultiPeerManager({ maxPeers: 12 });
  manager.on('error', () => {});
  await manager.connect();
  await new Promise(r => setTimeout(r, 20000));
  log('ready peers for tip confirmation:', manager.readyPeers.size);
  try { log('confirmTip:', JSON.stringify(await manager.confirmTip(recent.hash, { timeoutMs: 20000 }))); }
  catch (e) { log('confirmTip FAILED:', e.message); }
  manager.close();
  log('ALL SEGMENTS PASSED');
} catch (e) {
  log('VALIDATION FAILED:', e.message);
  process.exitCode = 1;
} finally { peer.close(); }
