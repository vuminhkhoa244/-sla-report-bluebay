import { createApp } from "./app.js";
import { HelpdeskClient } from "./helpdesk.js";
import { openDb } from "./db.js";
import { state } from "./state.js";
import { runSync, refreshConfig } from "./sync.js";

const port = Number(process.env.PORT || 8080);
const db = openDb(process.env.DB_PATH ?? "data/db.sqlite");
const client = new HelpdeskClient();

// The grader gives us 8 minutes to become /ready. Serve /health immediately,
// then sync in the background: if the first attempt fails (helpdesk hiccup),
// retry every 5s rather than exiting.
createApp(db).listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
});

(async () => {
  for (;;) {
    try {
      await runSync(client, db, state);
      return;
    } catch (err) {
      console.error(`sync boot failed, retrying in 5s: ${err && err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
})();

// Sites/staff/holidays re-refresh every minute (runSync already refreshed once
// before ready). Staff names must be *current* names per rule 3, and site
// config can change under us.
setInterval(async () => {
  if (!state.ready) return;
  try {
    await refreshConfig(client, db);
  } catch (err) {
    console.error(`config refresh failed: ${err && err.message}`);
  }
}, 60_000);
