import { serve } from "@hono/node-server";
import { migrate } from "./db.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3000);

await migrate();

const app = createApp();

// Ensure "/" still works if createApp static mount differs under cwd.
app.get("/favicon.ico", (c) => c.body(null, 204));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Clinic booking API listening on http://localhost:${port}`);
  console.log(`Web page: http://localhost:${port}/`);
});
