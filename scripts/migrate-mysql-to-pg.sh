#!/bin/bash
# ─── MySQL → PostgreSQL data migration ────────────────────────────────────────
#
# Exports all data from the local MySQL database and imports it into PostgreSQL.
#
# Prerequisites:
#   - mysqldump, mysql, psql, pgloader installed
#   - Source MySQL is running and accessible
#   - Target PostgreSQL is running with the schema already applied:
#       prisma db push --schema=packages/api/prisma/schema.prisma
#
# Usage:
#   MYSQL_URL="mysql://root:password@localhost:3306/aice_whatsapp" \
#   PG_URL="postgresql://postgres:password@your-pg-host:5432/aice_whatsapp" \
#   bash scripts/migrate-mysql-to-pg.sh
#
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

MYSQL_URL="${MYSQL_URL:?Set MYSQL_URL (e.g. mysql://root:password@localhost:3306/aice_whatsapp)}"
PG_URL="${PG_URL:?Set PG_URL (e.g. postgresql://postgres:password@host:5432/aice_whatsapp)}"

echo "=========================================="
echo " MySQL → PostgreSQL Migration"
echo "=========================================="
echo ""
echo "Source: $MYSQL_URL"
echo "Target: $PG_URL"
echo ""

# ─── Option 1: pgloader (recommended — handles type mapping automatically) ────
# pgloader is the most reliable way to migrate MySQL → PostgreSQL.
# Install: apt install pgloader  (or brew install pgloader on macOS)

if command -v pgloader &> /dev/null; then
  echo "[1/3] Using pgloader for migration..."
  echo ""

  # pgloader expects URLs in a specific format:
  #   mysql://user:pass@host/dbname
  #   postgresql://user:pass@host/dbname

  cat > /tmp/pgloader-migrate.conf <<EOF
LOAD DATABASE
  FROM    $MYSQL_URL
  INTO    $PG_URL

WITH include drop, create tables, create indexes,
     reset sequences, downcase identifiers

SET maintenance_work_mem to '512MB',
    work_mem to '48MB'

CAST type int with extra auto_increment to serial,
     type bigint with extra auto_increment to bigserial,
     type tinyint to boolean using tinyint-to-boolean

-- Prisma uses double-quoted identifiers in PostgreSQL
-- pgloader will handle the table/column name mapping

AFTER LOAD DO
  \$\$ UPDATE "Agent" SET status = 'OFFLINE' \$\$;
EOF

  pgloader /tmp/pgloader-migrate.conf
  rm -f /tmp/pgloader-migrate.conf

  echo ""
  echo "[2/3] Fixing PostgreSQL sequences..."
  # After pgloader, auto-increment sequences may be out of sync
  psql "$PG_URL" <<'SQLEOF'
-- Fix Agent id sequence (autoincrement)
SELECT setval('"Agent_id_seq"', COALESCE((SELECT MAX(id) FROM "Agent"), 0) + 1);
SQLEOF

  echo ""
  echo "[3/3] Verifying row counts..."
  psql "$PG_URL" <<'SQLEOF'
SELECT 'Agent' AS table_name, COUNT(*) FROM "Agent"
UNION ALL SELECT 'Department', COUNT(*) FROM "Department"
UNION ALL SELECT 'Area', COUNT(*) FROM "Area"
UNION ALL SELECT 'Contact', COUNT(*) FROM "Contact"
UNION ALL SELECT 'Campaign', COUNT(*) FROM "Campaign"
UNION ALL SELECT 'CampaignArea', COUNT(*) FROM "CampaignArea"
UNION ALL SELECT 'Message', COUNT(*) FROM "Message"
UNION ALL SELECT 'Reply', COUNT(*) FROM "Reply"
UNION ALL SELECT 'DailySendLog', COUNT(*) FROM "DailySendLog"
UNION ALL SELECT 'AppConfig', COUNT(*) FROM "AppConfig"
UNION ALL SELECT 'WarmSession', COUNT(*) FROM "WarmSession"
UNION ALL SELECT 'WarmSessionAgent', COUNT(*) FROM "WarmSessionAgent"
UNION ALL SELECT 'WarmExchange', COUNT(*) FROM "WarmExchange"
ORDER BY 1;
SQLEOF

  echo ""
  echo "Migration complete via pgloader."

else
  # ─── Option 2: Manual CSV export/import (if pgloader is not available) ──────

  echo "[!] pgloader not found. Falling back to manual CSV export/import."
  echo ""
  echo "Install pgloader for a smoother experience:"
  echo "  Ubuntu: sudo apt install pgloader"
  echo "  macOS:  brew install pgloader"
  echo ""

  # Parse MySQL URL components
  # Format: mysql://USER:PASSWORD@HOST:PORT/DATABASE
  MYSQL_USER=$(echo "$MYSQL_URL" | sed -E 's|mysql://([^:]+):.*|\1|')
  MYSQL_PASS=$(echo "$MYSQL_URL" | sed -E 's|mysql://[^:]+:([^@]+)@.*|\1|')
  MYSQL_HOST=$(echo "$MYSQL_URL" | sed -E 's|mysql://[^@]+@([^:]+):.*|\1|')
  MYSQL_PORT=$(echo "$MYSQL_URL" | sed -E 's|mysql://[^@]+@[^:]+:([0-9]+)/.*|\1|')
  MYSQL_DB=$(echo "$MYSQL_URL" | sed -E 's|mysql://[^/]+/(.+)|\1|')

  DUMP_DIR="/tmp/aice-migration-$(date +%s)"
  mkdir -p "$DUMP_DIR"

  # Tables in dependency order (parents before children)
  TABLES=(
    "AppConfig"
    "Department"
    "Agent"
    "Area"
    "Contact"
    "Campaign"
    "CampaignArea"
    "Message"
    "Reply"
    "DailySendLog"
    "WarmSession"
    "WarmSessionAgent"
    "WarmExchange"
  )

  echo "[1/4] Exporting tables from MySQL..."
  for table in "${TABLES[@]}"; do
    echo "  Exporting $table..."
    mysqldump -u "$MYSQL_USER" -p"$MYSQL_PASS" -h "$MYSQL_HOST" -P "$MYSQL_PORT" \
      --no-create-info --compatible=postgresql --complete-insert \
      --skip-triggers --skip-lock-tables \
      "$MYSQL_DB" "$table" > "$DUMP_DIR/$table.sql" 2>/dev/null || true
  done

  echo ""
  echo "[2/4] Ensuring PostgreSQL schema exists..."
  echo "  (Make sure you already ran: prisma db push)"
  echo ""

  echo "[3/4] Importing data into PostgreSQL..."
  echo ""
  echo "  NOTE: Direct SQL import from MySQL dumps into PostgreSQL often"
  echo "  requires manual fixes (quoting, booleans, dates, etc.)."
  echo ""
  echo "  Recommended: Install pgloader and re-run this script."
  echo ""
  echo "  Dump files are saved to: $DUMP_DIR/"
  echo ""

  echo "[4/4] Summary of exported files:"
  for table in "${TABLES[@]}"; do
    size=$(wc -l < "$DUMP_DIR/$table.sql" 2>/dev/null || echo "0")
    echo "  $table.sql: $size lines"
  done

  echo ""
  echo "Manual import steps:"
  echo "  1. Install pgloader (recommended)"
  echo "  2. Or manually edit the .sql files to fix PostgreSQL compatibility"
  echo "     (quote identifiers, convert tinyint(1) → boolean, etc.)"
  echo "  3. Import: psql \$PG_URL < $DUMP_DIR/<table>.sql"
fi

echo ""
echo "=========================================="
echo " Post-migration checklist"
echo "=========================================="
echo ""
echo "  1. Verify row counts match between MySQL and PostgreSQL"
echo "  2. Update Agent.profilePath values for Docker:"
echo "     UPDATE \"Agent\" SET \"profilePath\" = '/app/browser-profiles/agent-' || id;"
echo "  3. Reset Agent.status to OFFLINE:"
echo "     UPDATE \"Agent\" SET status = 'OFFLINE';"
echo "  4. Run the screenshot migration script next:"
echo "     pnpm --filter @aice/api exec tsx ../../scripts/migrate-screenshots-to-minio.ts"
echo ""
