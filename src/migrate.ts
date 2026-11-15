import { config } from "./load-env.js";
import { migrate, sql } from "./db.js";

config();
await migrate();
console.log("Migrations applied.");
await sql.end();
