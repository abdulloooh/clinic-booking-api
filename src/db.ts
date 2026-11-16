import postgres from "postgres";
import { config as loadEnv } from "./load-env.js";

loadEnv();

// Neon on Vercel usually sets DATABASE_URL; some installs use POSTGRES_URL.
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  throw new Error("DATABASE_URL or POSTGRES_URL is required");
}

export const sql = postgres(url, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30,
  prepare: false, // works with Neon pooler / serverless
});

export async function migrate() {
  await sql`
    create table if not exists slots (
      id text primary key,
      provider text not null,
      start_at timestamptz not null,
      end_at timestamptz not null
    )
  `;

  await sql`
    create table if not exists bookings (
      id text primary key,
      slot_id text not null references slots(id),
      name text not null,
      email text not null,
      status text not null check (status in ('confirmed', 'cancelled')),
      created_at timestamptz not null default now(),
      seq bigserial
    )
  `;

  // Only one confirmed booking per slot — this is what stops double booking under races.
  await sql`
    create unique index if not exists bookings_one_confirmed_per_slot
    on bookings (slot_id)
    where status = 'confirmed'
  `;

  await sql`create index if not exists bookings_email_seq on bookings (email, seq)`;

  await sql`
    create table if not exists idempotency_keys (
      key text primary key,
      body_hash text not null,
      status_code integer not null,
      response jsonb not null,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists booking_attempts (
      id bigserial primary key,
      email text not null,
      attempted_at timestamptz not null default now()
    )
  `;

  await sql`create index if not exists booking_attempts_email_time on booking_attempts (email, attempted_at)`;
}

export type SlotRow = {
  id: string;
  provider: string;
  start_at: Date;
  end_at: Date;
};

export type BookingRow = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: Date;
  seq: string | number;
};
