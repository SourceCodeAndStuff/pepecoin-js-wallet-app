# Security review — September 2026

Scope: the wallet library (`wallet/`), the web console (`web/`) and how they are run together. Method: code review, plus a local pentest of the running console (`npm start` against a throwaway data directory, with `ALLOW_REGISTRATION=1` and two operators) and crafted-peer tests of the P2P layer. Every finding below was reproduced before it was fixed. Each fix has a regression test.

## Findings and fixes

| # | Severity | Component | Finding | Fix |
| --- | --- | --- | --- | --- |
| 1 | High | wallet: sync | Headers were only checked for linkage. There was no proof-of-work, AuxPoW or difficulty check, and the sync peer was the one claiming the highest height. So one dishonest peer could serve zero-work blocks paying any watched address, and those blocks would be indexed as confirmed deposits. The proof of concept indexed 10,000,000 PEPE of fake coinbase outputs. | New `lib/pepenet-pow.js` checks every header before any body is requested: scrypt PoW, full AuxPoW proof and chain ID, DigiShield bits, median-time-past, the future-time limit and Core's checkpoints. After catching up, at least 2 other peers in different /16 ranges must confirm the tip. Deposits are only `eligible` at or below that `verifiedHeight`. |
| 2 | High | wallet: sync | Block bodies were buffered without a size check or a Merkle check. A peer could attach up to 32 MiB of junk to each of 500 real header hashes (~16 GB of memory), and duplicates then blocked the real body. | Bodies must match their header's Merkle root before they are kept, and the 256 MiB pending cap is enforced when each body arrives. |
| 3 | High | wallet: wire | AuxPoW header parsing copied the whole payload once per header. That is quadratic: 16k headers took 12 s, and one 32 MiB message could block the event loop for minutes. | Parse in place, and cap headers messages at the protocol maximum of 2,000. |
| 4 | Medium | wallet: P2P | A frame with the wrong network magic was kept, and every later chunk was appended forever (unbounded memory per connection). | Throw and drop the connection. Frames are also no longer re-concatenated on every TCP chunk. |
| 5 | Medium | wallet: P2P | `addr` gossip had no limit, and gossiped "full node" addresses jumped ahead of the configured peers. One peer could fill the candidate list and every future connection slot. | Capped at 2,000 candidates and 1,000 addresses per message. Gossip is queued after archive peers and DNS seeds. |
| 6 | Medium | wallet: P2P | The network height was the maximum any peer claimed. One peer advertising 99,999,999 kept the wallet from ever reaching `synced`. | Uses the median claim, and picks the sync peer at random from peers at or above the median. |
| 7 | Medium | wallet: relay | One peer echoing bytes back was enough to mark a withdrawal `relayed`, even for bytes that were not a valid transaction. | Two different peers must serve the transaction back. Otherwise the state is `unverified`, which can still confirm. |
| 8 | Medium | wallet + web: restore | Backup contents were trusted, and anyone can encrypt a crafted payload with their own passphrase. A restore could add reservations for any outpoint (freezing another operator's or namespace's coins), point withdrawals at other wallets, and store unvalidated contact addresses. | Only withdrawals, inputs, reservations and coin locks that belong to wallets inside the same backup are accepted, and contact addresses are validated. Any violation rolls back the whole restore. |
| 9 | Medium | web: spending lock | Any operator could release the vault-wide spending lock that another operator, or the host application, had set. | The lock records who set it. Only that operator can release it, and a lock set through the library cannot be released from the console. |
| 10 | Low | web: login | Account names could be enumerated. Unknown names failed about 20× faster, and a short password against a real account returned a different error. | Unknown accounts, malformed passwords and wrong passwords now do the same scrypt work and return the same 401. |
| 11 | Low | web: CSRF depth | `POST /console` accepted any content type. It was already protected by `SameSite=Strict` and Origin checks. | Only `application/json` is accepted (415 otherwise), so a cross-site HTML form cannot submit a command. |
| 12 | Low | wallet: P2P | A socket error after the handshake emitted `'error'` with no listener when a peer was used on its own (`connectDiscoveredPeer`). That crashes the process. | Close the peer when nobody is listening. |

## Checked and found sound

- **Access control between operators:** wallet, address, receive, coin, withdrawal, rebroadcast, export-key, sign and contact routes all enforce ownership (404 for other operators' wallets).
- **Host and origin:** the Host header allow-list blocks DNS rebinding, and cross-origin requests and sockets get 403. Sockets without an Origin header, or without a session, are refused. The socket accepts only `subscribe` messages and validates ownership.
- **Sessions:** 256-bit random tokens, `HttpOnly`, `SameSite=Strict` and `Secure` behind HTTPS. They are revoked on logout, and sockets close when the session ends.
- **Request limits and routing:** sign-in is rate-limited (10 per minute per address). Bodies are capped at 5 MiB. Path tricks such as `wallets/x/../../admin/…` normalize to routes that are still authorized. Static files come from a fixed map, so there is no traversal.
- **Browser output:** user-supplied labels and addresses are HTML-escaped, and the CSP blocks inline script.
- **SQL:** every query uses bound parameters.
- **Key handling:** keys are AES-256-GCM encrypted, passwords use scrypt, and verifiers are compared in constant time. Sensitive actions require the password again.

## Residual risks (not fixed here)

- The wallet does not execute scripts, check subsidies or roll back reorganizations. It is header-validating, not a full node.
- An attacker who controls most of your peers (an eclipse attack) and has real scrypt hash power could still mislead the index. Cross-check large deposits independently.
- The sign-in limiter is per client IP. Behind a reverse proxy, all clients share one limit.
- Blocks indexed before this upgrade were not re-validated. Run `npm run rescan` if you want every historical header checked.
