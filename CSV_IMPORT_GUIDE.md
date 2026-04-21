# CSV Import Guide

## Overview

The CSV import system allows you to import contact data directly to the database without using the UI or XLSX import flow. It uses the same phone normalization and database constraints as the standard XLSX import.

## Files Created

### 1. **`packages/api/src/lib/csv-import.ts`**
Core CSV import library that handles:
- CSV parsing with quoted field support
- Phone normalization using existing phone utility (8-14 digit validation)
- Department and Area creation/retrieval
- Contact upsert with duplicate handling
- Comprehensive error reporting

### 2. **`packages/api/src/scripts/import-csv.ts`**
CLI script for running the import from command line

### 3. **`data_kardus_updated.csv`**
Updated CSV file with Department column added (573 records mapped to Department 1-9)

## Setup

### Prerequisites
- Node.js environment with `tsx` and Prisma Client
- Database configured via `.env.dev` or `.env.prod`
- CSV file in correct format

### CSV Format

```
Nama,Phone,Area,Department
SAUT MR,6282294817778,Rantau,Department 1
RIA,6285273629826,Rantau,Department 1
...
```

**Columns:**
- `Nama` - Store/business name (required)
- `Phone` - Phone number in any Indonesian format (required)
- `Area` - Area name (required)
- `Department` - Department name (required)

## Usage

### Option 1: Using npm script (Recommended)

```bash
cd packages/api
npm run import:csv /path/to/your/file.csv
```

### Option 2: Direct tsx execution

```bash
cd packages/api
npx tsx src/scripts/import-csv.ts /path/to/your/file.csv
```

### Option 3: With relative path

```bash
cd project-root
npx tsx packages/api/src/scripts/import-csv.ts data_kardus_updated.csv
```

## Phone Number Handling

The script handles all Indonesian phone formats:

| Input Format | Normalized |
|---|---|
| `08xxxxxxxxx` | `+628xxxxxxxxx` |
| `8xxxxxxxxx` | `+628xxxxxxxxx` |
| `628xxxxxxxxx` | `+628xxxxxxxxx` |
| `+628xxxxxxxxx` | `+628xxxxxxxxx` |
| `8.2116746411E+10` | `+628211674641` |
| `0821 1674 641 1` | `+62821167464117` |

**Validation:** After `+62`, remaining digits must be 8-14 digits.

## Output

The script displays:
- Progress updates every 50 records
- Total records processed
- Number of imported records
- Number of invalid records
- Number of duplicates
- Details of first 10 invalid records

### Example Output:

```
============================================================
🚀 CSV IMPORT SCRIPT
============================================================
📄 File: /absolute/path/to/data_kardus_updated.csv

📖 Parsing CSV file: /absolute/path/to/data_kardus_updated.csv
✅ Parsed 573 records

🔄 Processing records...

  📁 Created Department: Department 1
  📍 Created Area: Rantau (Department: Department 1)
  ✓ Processed 50/573 (50 imported, 0 invalid)
  ✓ Processed 100/573 (100 imported, 0 invalid)
  ...
  📁 Created Department: Department 2
  📍 Created Area: Bogor Barat (Department: Department 2)
  ...

============================================================
📊 IMPORT SUMMARY
============================================================
  Total Records:     573
  ✅ Imported:        573
  ⚠️  Invalid:        0
  🔄 Duplicates:     0
============================================================
```

## Database Operations

The script performs:

1. **Department Lookup/Creation**
   - Checks if Department exists by name
   - Creates if not found
   - Caches for subsequent records

2. **Area Lookup/Creation**
   - Checks if Area exists with unique constraint: `(departmentId, name, contactType: "KARDUS")`
   - Creates if not found
   - Caches for subsequent records

3. **Contact Upsert**
   - Inserts new contacts or updates existing ones
   - Unique constraint: `(areaId, phoneNorm)`
   - All contacts created with `contactType: "KARDUS"`
   - Normalizes phone to E.164 format
   - Sets `phoneValid: true` and `waChecked: false`

## Error Handling

Invalid records are reported with:
- Row number (matching CSV line numbers)
- Store name
- Reason for failure

Common errors:
- `empty` - Phone field is empty
- `invalid phone number` - Phone doesn't match expected format
- `subscriber number is X digit(s) — expected 8–14` - Phone suffix outside valid range
- Database errors - Constraints or connection issues

## For Your data_kardus_updated.csv

**573 total records** distributed as:

| Department | Count |
|---|---|
| Department 1 | 78 |
| Department 2 | 189 |
| Department 3 | 3 |
| Department 4 | 44 |
| Department 5 | 72 |
| Department 6 | 129 |
| Department 7 | 27 |
| Department 8 | 22 |
| Department 9 | 35 |

## Notes

- All contacts are imported with `contactType: "KARDUS"`
- Phone numbers are normalized to E.164 format (e.g., `+628xxxxxxxxx`)
- Duplicate phone numbers within the same area will not be re-imported
- The script creates departments and areas on-demand as they're encountered
- Empty rows in CSV are skipped
- The script uses the `.env.dev` environment by default (change in package.json if needed)
