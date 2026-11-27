// Pandorf Swap — a minimal exchange UI for GIWA Sepolia, built on @ammora-protocol/sdk.
// Quotes, approvals and swap transactions come from the SDK's AmmoraSwapClient;
// the user's own wallet (Rabby, MetaMask…) signs every transaction.
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
} from "viem";
import {
  AmmoraSwapClient,
  ammoraV3NativeRouterAbi,
  giwaSepoliaAutoRouteDeployment as deployment,
  giwaSepoliaAutoRoutePoolProfiles,
} from "@ammora-protocol/sdk";

const RPC = "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";
const WETH = getAddress(deployment.contracts.tokens.wrappedNative);
const chain = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
});

// Native ETH router used by ammora.org for GIWA ARL pools (same ABI as the SDK's
// ammoraV3NativeRouterAbi). The SDK 0.3.9 catalog router does not enable these pools yet,
// so the SDK plans the quote on the WETH leg and this router wraps/unwraps ETH atomically.
const NATIVE_ROUTER = getAddress("0x4FC91b90087288520A7bB4aA7Ab5441bb4E9C496");
const ZERO = "0x0000000000000000000000000000000000000000";

// Known markets. Any other Ammora pool can be added with the "custom pool" form.
const MARKETS = [
  {
    id: "tamm",
    label: "tAMM / ETH",
    pool: getAddress("0x1EF92A6a9BB4bBed2b385Dd5E688F88e7965BCf8"),
    token: getAddress("0x10B3Cc2fc981277Ada576891CF649D0ABA768B06"),
    model: "compounding",
  },
];

const publicClient = createPublicClient({ chain, transport: http(RPC, { retryCount: 1 }) });
let swapClientPromise;
const swapClient = () =>
  (swapClientPromise ??= AmmoraSwapClient.create(publicClient, {
    deploymentCatalog: { [chain.id]: deployment },
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  }));

const tokenInfo = new Map();
async function token(address) {
  const key = address.toLowerCase();
  if (!tokenInfo.has(key)) {
    tokenInfo.set(
      key,
      Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]).then(([symbol, decimals]) => ({ address, symbol, decimals: Number(decimals) })),
    );
  }
  return tokenInfo.get(key);
}

/** Quote via the SDK on the WETH leg, then build the native-router transaction. */
async function plan({ market, side, amount, payer, slippageBps }) {
  const t = await token(market.token);
  const buy = side === "buy";
  const amountIn = parseUnits(amount, buy ? 18 : t.decimals);
  if (amountIn <= 0n) throw new Error("Enter an amount greater than zero");
  const client = await swapClient();
  const sdkPlan = await client.prepareExactIn({
    model: market.model,
    pool: market.pool,
    tokenIn: buy ? WETH : market.token,
    inputAsset: "erc20",
    outputAsset: "erc20",
    amountIn,
    payer,
    recipient: payer,
    slippageBps,
    executionMode: "direct-wallet",
  });
  const q = sdkPlan.quote;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const data = buy
    ? encodeFunctionData({ abi: ammoraV3NativeRouterAbi, functionName: "swapPoolExactInNative", args: [market.pool, q.minimumAmountOut, payer, deadline, ZERO] })
    : encodeFunctionData({ abi: ammoraV3NativeRouterAbi, functionName: "swapPoolExactInForNative", args: [market.pool, market.token, amountIn, q.minimumAmountOut, payer, deadline, ZERO] });
  return {
    token: t,
    buy,
    amountIn,
    quote: { expectedAmountOut: q.expectedAmountOut, minimumAmountOut: q.minimumAmountOut },
    tx: { to: NATIVE_ROUTER, data, value: buy ? amountIn : 0n },
    approval: buy ? null : { token: market.token, spender: NATIVE_ROUTER, amount: amountIn },
  };
}

/** Sends approval (if needed) and the swap from the user's wallet, then waits for receipts. */
async function execute(p, account, onStatus) {
  await ensureChain(window.ethereum);
  const wallet = createWalletClient({ account, chain, transport: custom(window.ethereum) });
  if (p.approval) {
    const allowance = await publicClient.readContract({ address: p.approval.token, abi: erc20Abi, functionName: "allowance", args: [account, p.approval.spender] });
    if (allowance < p.approval.amount) {
      onStatus("Approve the token in your wallet…");
      const h = await wallet.writeContract({ address: p.approval.token, abi: erc20Abi, functionName: "approve", args: [p.approval.spender, p.approval.amount] });
      onStatus("Waiting for approval…");
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error("Approval failed");
    }
  }
  onStatus("Simulating…");
  await publicClient.call({ account, to: p.tx.to, data: p.tx.data, value: p.tx.value });
  onStatus("Confirm the swap in your wallet…");
  const hash = await wallet.sendTransaction({ to: p.tx.to, data: p.tx.data, value: p.tx.value });
  onStatus("Waiting for confirmation…");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Swap reverted");
  return { hash };
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const state = { account: null, market: MARKETS[0], side: "buy", prepared: null, busy: false };
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v, d, max = 6) => {
  const n = Number(formatUnits(v, d));
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? max : 4 });
};

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

function renderMarkets() {
  const sel = $("market");
  sel.innerHTML = "";
  for (const m of MARKETS) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.append(o);
  }
  sel.value = state.market.id;
}

async function refreshBalances() {
  const t = await token(state.market.token);
  $("pair-symbol").textContent = t.symbol;
  $("pool-link").href = `${EXPLORER}/address/${state.market.pool}`;
  $("pool-link").textContent = short(state.market.pool);
  $("in-symbol").textContent = state.side === "buy" ? "ETH" : t.symbol;
  $("out-symbol").textContent = state.side === "buy" ? t.symbol : "ETH";
  if (!state.account) {
    $("balance").textContent = "—";
    return;
  }
  const [eth, bal] = await Promise.all([
    publicClient.getBalance({ address: state.account }),
    publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }),
  ]);
  state.balances = { eth, token: bal, decimals: t.decimals };
  $("balance").textContent =
    state.side === "buy" ? `${fmt(eth, 18)} ETH` : `${fmt(bal, t.decimals)} ${t.symbol}`;
}

let quoteTimer;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  state.prepared = null;
  $("swap").disabled = true;
  $("out").textContent = "0";
  $("min-out").textContent = "—";
  quoteTimer = setTimeout(runQuote, 450);
}

async function runQuote() {
  const amount = $("amount").value.trim();
  if (!amount || Number(amount) <= 0) return setStatus("");
  if (!/^\d*\.?\d*$/.test(amount)) return setStatus("Invalid amount", "err");
  setStatus("Fetching quote…");
  try {
    const payer = state.account ?? "0x000000000000000000000000000000000000dEaD";
    const p = await plan({
      market: state.market,
      side: state.side,
      amount,
      payer,
      slippageBps: Number($("slippage").value),
    });
    if ($("amount").value.trim() !== amount) return; // stale
    const outDecimals = p.buy ? p.token.decimals : 18;
    $("out").textContent = fmt(p.quote.expectedAmountOut, outDecimals);
    $("min-out").textContent = `${fmt(p.quote.minimumAmountOut, outDecimals)} ${p.buy ? p.token.symbol : "ETH"}`;
    state.prepared = p;
    $("swap").disabled = !state.account;
    setStatus(state.account ? "Quote ready" : "Connect a wallet to swap", state.account ? "ok" : "");
  } catch (e) {
    setStatus(cleanError(e), "err");
  }
}

function cleanError(e) {
  const msg = e?.shortMessage || e?.message || String(e);
  return msg.split("\n")[0].slice(0, 220);
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) return setStatus("No wallet found. Install Rabby or MetaMask.", "err");
  try {
    const [addr] = await eth.request({ method: "eth_requestAccounts" });
    await ensureChain(eth);
    state.account = getAddress(addr);
    $("connect").textContent = short(state.account);
    eth.on?.("accountsChanged", (a) => {
      state.account = a[0] ? getAddress(a[0]) : null;
      $("connect").textContent = state.account ? short(state.account) : "Connect wallet";
      refreshBalances().then(scheduleQuote);
    });
    await refreshBalances();
    scheduleQuote();
  } catch (e) {
    setStatus(cleanError(e), "err");
  }
}

async function ensureChain(eth) {
  const hex = `0x${chain.id.toString(16)}`;
  const current = await eth.request({ method: "eth_chainId" });
  if (current === hex) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if (err?.code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [RPC],
        blockExplorerUrls: [EXPLORER],
      }],
    });
  }
}

async function swap() {
  if (!state.prepared || !state.account || state.busy) return;
  state.busy = true;
  $("swap").disabled = true;
  try {
    const result = await execute(state.prepared, state.account, (t) => setStatus(t));
    const link = `${EXPLORER}/tx/${result.hash}`;
    $("status").innerHTML = `Swap confirmed · <a href="${link}" target="_blank" rel="noopener">view on explorer</a>`;
    $("status").className = "status ok";
    $("amount").value = "";
    await refreshBalances();
  } catch (e) {
    setStatus(cleanError(e), "err");
  } finally {
    state.busy = false;
    $("swap").disabled = !state.prepared;
  }
}

function addCustomMarket(ev) {
  ev.preventDefault();
  const pool = $("c-pool").value.trim();
  const tok = $("c-token").value.trim();
  if (!isAddress(pool) || !isAddress(tok)) return setStatus("Enter valid pool and token addresses", "err");
  token(getAddress(tok))
    .then((t) => {
      const m = { id: pool.toLowerCase(), label: `${t.symbol} / ETH`, pool: getAddress(pool), token: getAddress(tok), model: $("c-model").value };
      if (!MARKETS.some((x) => x.id === m.id)) MARKETS.push(m);
      state.market = m;
      renderMarkets();
      $("custom").open = false;
      return refreshBalances().then(scheduleQuote);
    })
    .catch((e) => setStatus(cleanError(e), "err"));
}

function wire() {
  renderMarkets();
  $("connect").onclick = connect;
  $("market").onchange = (e) => {
    state.market = MARKETS.find((m) => m.id === e.target.value);
    refreshBalances().then(scheduleQuote);
  };
  for (const b of document.querySelectorAll("[data-side]")) {
    b.onclick = () => {
      state.side = b.dataset.side;
      document.querySelectorAll("[data-side]").forEach((x) => x.classList.toggle("active", x === b));
      refreshBalances().then(scheduleQuote);
    };
  }
  $("amount").oninput = scheduleQuote;
  $("slippage").onchange = scheduleQuote;
  $("max").onclick = () => {
    if (!state.balances) return;
    const { eth, token: bal, decimals } = state.balances;
    const keep = parseUnits("0.002", 18); // leave gas
    $("amount").value =
      state.side === "buy" ? formatUnits(eth > keep ? eth - keep : 0n, 18) : formatUnits(bal, decimals);
    scheduleQuote();
  };
  $("swap").onclick = swap;
  $("custom-form").onsubmit = addCustomMarket;
  refreshBalances().catch((e) => setStatus(cleanError(e), "err"));
}

// Read-only helper for diagnostics: quote and simulate without signing.
window.pandorfSwap = {
  async quote(side = "buy", amount = "0.0002", payer = "0x000000000000000000000000000000000000dEaD") {
    const p = await plan({ market: state.market, side, amount, payer, slippageBps: 100 });
    const d = p.buy ? p.token.decimals : 18;
    let simulation = "skipped (needs allowance)";
    if (!p.approval) {
      try { await publicClient.call({ account: payer, to: p.tx.to, data: p.tx.data, value: p.tx.value }); simulation = "ok"; }
      catch (e) { simulation = cleanError(e); }
    }
    return { side, amountIn: amount, expectedOut: formatUnits(p.quote.expectedAmountOut, d), minimumOut: formatUnits(p.quote.minimumAmountOut, d), simulation };
  },
};

wire();
