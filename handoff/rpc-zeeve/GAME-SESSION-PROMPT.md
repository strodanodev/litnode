litVM moved its testnet RPC. Update this game's repo to the new endpoint.

FACTS (verified 11 Nov 2026 by the litnode session):
- New RPC: https://rpc.testnet.liteforge.zeeve.net/ . Same chain (LiteForge, chain id 4441), same contracts, same addresses. Only the URL changes.
- Old Caldera RPC https://liteforge.rpc.caldera.xyz/http FROZE at block 69,908,990 (11 Nov 03:50Z) but STILL ANSWERS with that old head. That is worse than being down: any client or server that lists Caldera, even as a fallback, silently reads a stale chain, and transactions sent there never land. https://liteforge.rpc.caldera.xyz/infra-partner-http is down.
- arcade.litvm.games/contracts.json is already live with "rpc": "https://rpc.testnet.liteforge.zeeve.net/" and "rpcFallback": []. litnode master (uncommitted 0.12.5 work) and sdk/court's DEFAULT_RPCS now hold Zeeve only.

DO:
1. Search the whole repo (code, config, .env.example files, docs, tests, wallet chain configs) for `caldera`, `liteforge.rpc`, `infra-partner-http` and any hard-coded RPC list.
2. Replace them with https://rpc.testnet.liteforge.zeeve.net/ . Do NOT keep Caldera as a fallback anywhere. A fallback list of just [Zeeve] is correct for now. If the code fails over to the next URL only on errors, a frozen fallback wins the first time Zeeve times out.
3. Keep reading arcade.litvm.games/contracts.json first where the game already does. Only the last-resort default changes.
4. Check eth_getLogs use. Zeeve costs about 2.7 s per getLogs call however small the range, and times out (about 30 s) on large or unindexed ranges. Scan from a recent block, not from deploy, and size ranges by throughput rather than shrinking on latency. Caldera answered fast, so code tuned there may crawl on Zeeve.
5. Wallets: wallet_addEthereumChain / chain configs (MetaMask, AIR, wagmi/viem chain objects) must list Zeeve in rpcUrls. MetaMask will NOT change the RPC of a network a player already added. If the game reads chain state through window.ethereum, read through your own Zeeve client instead, or tell players to edit the LiteForge network's RPC URL in their wallet.
6. Server-side env (Vercel, Neon jobs, courts, relays): list every env var that holds an RPC URL (RPC, RPC_URL, LITVM_RPC, NEXT_PUBLIC_*…) and its value per environment. Changing a managed env var and redeploying is a user step: give the user the exact variable names and values. Never copy .env files or keys between machines.
7. Run the repo's tests. Do one live smoke read: eth_chainId must return 0x1159, and eth_blockNumber must be well above 69,908,990 and rising.
8. Commit on a branch with a short message ("RPC: litVM Zeeve endpoint, drop frozen Caldera"). Do not push, deploy or release unless the user says so. Report: files changed, env vars the user must change, whether a redeploy or release is needed, and anything that still points at Caldera.

DON'T: change contract addresses, chain id or game logic; touch litnode code (that is the litnode session's).
