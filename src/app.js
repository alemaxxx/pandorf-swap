// Pandorf Swap — a minimal exchange UI for GIWA Sepolia, built on @ammora-protocol/sdk.
// Quotes, approvals and swap transactions come from the SDK's AmmoraSwapClient;
// the user's own wallet (Rabby, MetaMask…) signs every transaction.
import {
  createPublicClient,
  createWalletClient,
  custom,
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

/** Builds an SDK plan. side = "buy" (ETH → token) or "sell" (token → ETH). */
async function plan({ market, side, amount, payer, slippageBps }) {
  const t = await token(market.token);
  const buy = side === "buy";
  const amountIn = parseUnits(amount, buy ? 18 : t.decimals);
  if (amountIn <= 0n) throw new Error("Enter an amount greater than zero");
  const client = await swapClient();
  const prepared = await client.prepareExactIn({
    model: market.model,
    pool: market.pool,
    tokenIn: buy ? WETH : market.token,
    inputAsset: buy ? "native" : "erc20",
    outputAsset: buy ? "erc20" : "native",
    amountIn,
    payer,
    recipient: payer,
    slippageBps,
    executionMode: "direct-wallet",
  });
  return { prepared, token: t, buy, amountIn };
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
    const { prepared, token: t, buy } = await plan({
      market: state.market,
      side: state.side,
      amount,
      payer,
      slippageBps: Number($("slippage").value),
    });
    if ($("amount").value.trim() !== amount) return; // stale
    const outDecimals = buy ? t.decimals : 18;
    $("out").textContent = fmt(prepared.quote.expectedAmountOut, outDecimals);
    $("min-out").textContent = `${fmt(prepared.quote.minimumAmountOut, outDecimals)} ${buy ? t.symbol : "ETH"}`;
    state.prepared = prepared;
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
    await ensureChain(window.ethereum);
    const wallet = createWalletClient({ account: state.account, chain, transport: custom(window.ethereum) });
    const result = await state.prepared.execute(wallet, {
      onStatus: (s) => setStatus(describe(s)),
    });
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

function describe(s) {
  const k = s?.type || s?.status || s?.stage || "working";
  const map = {
    refreshing: "Refreshing quote…",
    approving: "Approve the token in your wallet…",
    "approval-confirmed": "Approval confirmed",
    simulating: "Simulating…",
    submitting: "Confirm the swap in your wallet…",
    submitted: "Waiting for confirmation…",
    confirmed: "Confirmed",
  };
  return map[k] || `${String(k).replace(/[-_]/g, " ")}…`;
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

// Read-only helper for diagnostics: quote without a wallet.
window.pandorfSwap = {
  async quote(side = "buy", amount = "0.0002", payer = "0x000000000000000000000000000000000000dEaD") {
    const { prepared, token: t, buy } = await plan({ market: state.market, side, amount, payer, slippageBps: 100 });
    const q = prepared.quote;
    return {
      side,
      amountIn: amount,
      expectedOut: formatUnits(q.expectedAmountOut, buy ? t.decimals : 18),
      minimumOut: formatUnits(q.minimumAmountOut, buy ? t.decimals : 18),
      to: prepared.transaction.to,
      approvals: prepared.approvalRequirements.length,
    };
  },
};

wire();
