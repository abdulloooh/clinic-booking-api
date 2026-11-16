import { handle } from "hono/vercel";
import { migrate } from "../src/db.js";
import { createApp } from "../src/app.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ready = migrate();
const app = createApp();

const handler = handle(app);

export default async function (request: Request) {
  await ready;
  return handler(request);
}
