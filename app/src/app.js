import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state } from "./state.js";
import { computeSlaReport } from "./rules.js";
import { browseRows } from "./queries.js";
import { parseRange, BadInput } from "./validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const invalid = (res, message) => res.status(400).json({ error: message });

export function createApp(db) {
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
    let range;
    try {
      range = parseRange(req.query);
    } catch (err) {
      return invalid(res, err.message);
    }
    res.json(computeSlaReport(db, range));
  });

  app.get("/api/requests", (req, res) => {
    if (!state.ready) return res.status(503).json({ error: "not ready" });
    if (!req.query.from || !req.query.to) return invalid(res, "missing or invalid from/to");
    try {
      res.json(browseRows(db, req.query));
    } catch (err) {
      if (err instanceof BadInput) return invalid(res, err.message);
      throw err;
    }
  });

  return app;
}
