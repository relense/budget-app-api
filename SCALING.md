# Scaling & Growth — Future Reference

Not for now. This is a reference for when there's real traffic/growth, not a to-do list for Phase 1-3. Nothing here should influence how the app is built today — the current architecture (Docker, Prisma, portable env-var config) already keeps every path below open without extra work now.

## Hosting path
1. **Now**: Railway or Render, free/cheap tier. Zero ops burden while there are no real users.
2. **When managed pricing starts hurting**: migrate to a self-hosted VPS (e.g. Hetzner, ~€5-10/mo covers both API and DB at this stage) running the same `docker-compose.yml` already used for local dev. This works because nothing platform-specific was introduced along the way — it's a config change (where the container runs), not a rewrite.
3. Self-hosting trade-off to remember: you take on backups, SSL (Caddy/Traefik handles this reasonably easily), OS security patching, and uptime monitoring yourself — a managed platform was doing all of that for you.

## Horizontal scaling (once one VPS/instance isn't enough)
- Split API and DB onto separate machines — several small VPS instances running identical copies of the API, one VPS (or managed service) dedicated solely to Postgres.
- Needs a load balancer in front of the API instances to distribute traffic — Hetzner offers a managed load balancer, or self-manage with Traefik/HAProxy, or put Cloudflare in front.
- This is exactly where connection pooling (see System Design Notes in the main plan) stops being optional — N api instances × pool size can exceed Postgres's connection limit fast. Use the hosting provider's pooled connection string, or PgBouncer if self-hosting the DB.

## Database migration (moving Postgres to a new host)
- Mechanically straightforward: `pg_dump` from the old instance, `pg_restore` into the new one.
- Two things not to skip when it actually happens:
  - **Downtime window**: either accept a short window with no writes during the dump/restore, or set up replication and cut over — for a personal-finance-scale app growing gradually, a short window is a reasonable tradeoff, no need to over-engineer this.
  - **Connection string swap**: update the DB connection env var everywhere the API reads it (all instances, all environments) right after cutover — easy to forget one.

## Revisit trigger
Come back to this file when there's an actual, measured reason — rising hosting bills, real concurrent users, or connection errors under load — not preemptively. If none of that has happened, the current setup is still the right one.
