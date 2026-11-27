import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const app = express();
const root = join(dirname(fileURLToPath(import.meta.url)), "public");
app.disable("x-powered-by");
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.get("/health", (_, res) => res.json({ ok: true, app: "pandorf-swap" }));
app.use(express.static(root, { maxAge: "5m" }));
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`pandorf-swap on :${port}`));
