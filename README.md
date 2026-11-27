# Pandorf Swap

A minimal exchange for **GIWA Sepolia** built on the [Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk) (`@ammora-protocol/sdk@0.3.9`).

- Buy and sell Ammora pool tokens with native ETH (starts with the **tAMM / ETH** compounding pool).
- Quotes, slippage-bound minimum output, ERC-20 approvals and the swap transaction are all planned by the SDK's `AmmoraSwapClient` (`prepareExactIn` → `PreparedExactInputSwap.execute`).
- Any other Ammora pool (compounding, concentrated, ALMM or pre-graduation launch curve) can be added from the UI by address.
- The user's own wallet (Rabby, MetaMask…) signs every transaction. No keys on the server.

## Run

```sh
npm install
npm run build   # bundles src/app.js → public/app.js
npm start       # serves public/ on $PORT (default 8080)
```

Testnet software for the Ammora Season 2 Builder mission. Not audited; do not use with real funds.
