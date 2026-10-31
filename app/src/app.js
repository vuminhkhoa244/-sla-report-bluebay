import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state } from "./state.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Validates ?from and ?to as real YYYY-MM-DD calendar dates, from <= to.
// Returns {from, to} or null (meaning 400).
export function parseRange(query) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = query.from;
  const to = query.to;
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (!dateRe.test(from) || !dateRe.test(to)) return null;
  // String comparison alone would accept 2026-02-31; build the date back.
  const parse = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
  };
  const fromD = parse(from);
  const toD = parse(to);
  if (!fromD || !toD || fromD > toD) return null;
  return { from, to };
}

export function createApp(db, rules) {
  const app = express();

  app.use(express.static(path.join(here, "..", "public")));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", (req, res) => {
    if (state.ready) res.json({ ready: true });
    else res.status(503).json({ ready: false });
  });

  app.get("/api/sla-report", (req, res) => {
    if (!state.ready) return res.status(503).json({ error: "not ready" });
    const range = parseRange(req.query);
    if (!range) return res.status(400).json({ error: "invalid from/to (need YYYY-MM-DD, from <= to)" });
    // milestone 2 wires the rules engine here
    res.status(501).json({ error: "not implemented" });
  });

  app.get("/api/requests", (req, res) => {
    // Level 4: filters, sorting and keyset pagination over the same rows.
    // Implemented in queries.js; wired here in milestone 5.
    res.status(501).json({ error: "not implemented" });
  });

  return app;
}
