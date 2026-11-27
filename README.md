# Pandorf Swap

A minimal exchange for **GIWA Sepolia** built on the [Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk) (`@ammora-protocol/sdk@0.3.9`).

- Buy and sell Ammora pool tokens with native ETH (starts with the **tAMM / ETH** compounding pool).
- Quotes come straight from the pool (`quoteExactIn`, SDK `ammCompoundingPoolV3Abi`) with a slippage-bound minimum output; swaps go through the GIWA native ETH router (SDK `ammoraV3NativeRouterAbi`), so ETH is wrapped/unwrapped in the same transaction.
- Any other ETH-quoted Ammora pool can be added from the UI by address (base/quote tokens are read on-chain).
- The user's own wallet (Rabby, MetaMask…) signs every transaction. No keys on the server.

## Run

```sh
npm install
npm run build   # bundles src/app.js → public/app.js
npm start       # serves public/ on $PORT (default 8080)
```

Testnet software for the Ammora Season 2 Builder mission. Not audited; do not use with real funds.
