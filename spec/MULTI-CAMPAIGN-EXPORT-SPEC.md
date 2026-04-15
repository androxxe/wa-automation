# Multi-Campaign Export Specification

## Overview

The multi-campaign export feature allows users to export all campaigns' data into a single XLSX file with multiple sheets, each containing one campaign's complete report with embedded screenshots.

## Feature Motivation

Previously, users could only export one campaign at a time. With many campaigns running monthly, this required multiple downloads and manual consolidation. The multi-campaign export provides:

- **Single file** containing all campaign reports
- **One sheet per campaign** with consistent formatting
- **Embedded screenshots** for visual verification
- **Summary sheet** with global statistics across all campaigns
- **Efficient processing** suitable for large campaign volumes

## Architecture

### Backend Implementation

#### Function: `buildAllCampaignsReportXlsx()`

Location: `packages/api/src/lib/report-xlsx.ts`

```typescript
export async function buildAllCampaignsReportXlsx(): Promise<Buffer>
```

**Workflow:**

1. Fetch all campaigns from database, ordered by `bulan DESC` (newest first)
2. For each campaign:
   - Create a new worksheet named `{index}_{bulan}_{campaignType}` (truncated to 31 chars)
   - Fetch all contacts and messages for that campaign across all areas
   - For each contact with a message:
     - Add data row with standard columns
     - Embed screenshot if available
     - Apply color coding and formatting (same as single-campaign export)
3. Generate a **Summary** sheet containing:
   - Generation timestamp
   - Total campaigns count
   - Global statistics (total rows, valid/invalid replies)
   - List of all campaigns included

**Key Details:**

- **Sheet naming:** Uses campaign name with timestamp appended to ensure uniqueness
  - Format: `{campaignName}_{YYYYMMDD}` (truncated to 31 characters, Excel's sheet name limit)
  - Example: `STIK Januar_20250415`, `KARDUS Januar_20250415`, `STIK Februar_20250415`
  - Timestamp is the export date, ensuring no collisions even with identical campaign names
- **Data structure:** Identical to `buildCampaignReportXlsx()` for consistency
- **Row ordering:** Contacts ordered by `seqNo` then `storeName` within each area
- **Formatting:** 
  - Headers: Bold, gray background, centered
  - Jawaban cells: Green for "Ya", red for "Tidak", gray for pending
  - Kategori cells: Color-coded by category (confirmed, denied, question, etc.)
  - Status cells: Red for invalid, green for valid
  - Even rows: Light gray background for readability
  - Images: Embedded at 240×180px, row height auto-adjusted

#### API Endpoint: `GET /api/export/report-xlsx-all`

Location: `packages/api/src/routes/export.ts`

```
GET /api/export/report-xlsx-all
```

**Response:**

- HTTP 200: Binary XLSX buffer
- HTTP 500: JSON error object `{ ok: false, error: string }`

**Headers:**

```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="laporan_semua_campaign_{YYYY-MM-DD}.xlsx"
```

**Filename format:** `laporan_semua_campaign_{YYYY-MM-DD}.xlsx`

### Frontend Implementation

#### Component: `ExportDropdown`

Location: `packages/web/src/pages/Responses.tsx`

**New Handler:** `handleDownloadAllCampaigns()`

```typescript
async function handleDownloadAllCampaigns() {
  setDl(true)
  setOpen(false)
  try {
    const res = await fetch(`/api/export/report-xlsx-all`)
    // Error handling...
    const blob = await res.blob()
    // Trigger download...
  } catch (err) {
    alert(`Download failed: ${String(err)}`)
  } finally {
    setDl(false)
  }
}
```

**UI Changes:**

- Reorganized export menu into clear sections:
  1. "Export all responses (XLSX)" — basic export
  2. "Write to Output Folder" — file system export
  3. **"Download report (with screenshots)"**
     - **NEW:** "All Campaigns (Multi-Sheet)" button
  4. **"Download report per campaign"** (existing)
     - Campaign picker
     - "Download XLSX" button

**Button Styling:**

- "All Campaigns" button: Accent color (distinguishes it as a feature)
- "Download XLSX" button: Primary color (existing behavior)

## Data Structure

### Campaign Sheet

Each campaign sheet contains:

| Column | Type | Description |
|--------|------|-------------|
| No | Integer | Sequential row number (1-based) |
| Nama Toko | String | Store name from contact |
| Nomor HP Toko | String | Normalized phone number |
| Department | String | Department name |
| Area | String | Area name |
| Agent Phone | String | Phone number of sending agent |
| Jawaban | String | "Ya" / "Tidak" / "Pending" / "" |
| Kategori | String | Claude category (confirmed, denied, question, etc.) |
| Status | String | "Valid" / "⚠ Invalid" / "" |
| Dikirim pada | DateTime | Message send timestamp (Asia/Jakarta TZ) |
| Dibalas pada | DateTime | Reply received timestamp (Asia/Jakarta TZ) |
| Raw Response | String | Full reply text from customer |
| Screenshot | Image | Embedded screenshot (if available) |

### Summary Sheet

| Row | Content |
|-----|---------|
| 1 | "Laporan AICE WhatsApp Automation — All Campaigns" (bold, size 13) |
| 2 | Blank |
| 3 | Generated: {timestamp} |
| 4 | Total campaigns: {count} |
| 5 | Total rows: {count} |
| 6 | Valid replies: {count} |
| 7 | Invalid replies: {count} |
| 8 | Blank |
| 9 | "Campaign List:" (bold) |
| 10+ | One campaign per row: `{bulan} - {campaignType} - {name}` |

## User Workflow

1. Navigate to "Responses" page
2. Click "Export" button
3. Select **"All Campaigns (Multi-Sheet)"**
4. Button shows "Generating…" while processing
5. Browser downloads file: `laporan_semua_campaign_{date}.xlsx`
6. File contains:
   - One sheet per active campaign
   - Summary sheet with overview
   - All screenshots embedded
   - Professional formatting

**Timing:**

- For ~10 campaigns with 100-300 contacts each: typically 5-30 seconds
- Progress indicated by button state ("Generating…")

## Error Handling

**Scenarios:**

1. **No campaigns exist** → 500 error: "No campaigns found"
2. **Database connection fails** → 500 error: "Database error message"
3. **Screenshot file missing** → Image skipped, path shown in cell as text
4. **Network timeout** → Frontend displays alert: "Download failed: {error}"

**User Experience:**

- All errors trigger `alert()` dialog with error message
- Button returns to normal state on error
- Graceful degradation: missing screenshots don't block export

## Performance Considerations

### Database Queries

- Single batch query to fetch all campaigns with relations
- Separate query per campaign for contacts + messages (within loop)
- Consider adding pagination or filtering for deployments with 100+ campaigns

### Memory Usage

- All campaign data held in memory during XLSX generation
- Screenshot buffers loaded individually (not all at once)
- Typical memory footprint: 100-500MB for 10-20 campaigns

### Optimization Opportunities

- Implement streaming XLSX generation for very large datasets
- Add campaign filtering (e.g., date range, campaign type)
- Cache workbook objects between requests
- Parallel screenshot loading (current: sequential)

## Testing Checklist

- [ ] Export all campaigns to single file
- [ ] Verify sheet names are unique (no duplicates)
- [ ] Check Summary sheet contains all campaigns
- [ ] Verify screenshots are embedded in all sheets
- [ ] Test with campaigns having identical `bulan` + `campaignType`
- [ ] Test with campaigns having missing screenshots
- [ ] Test with empty campaigns (no contacts/replies)
- [ ] Verify file naming convention
- [ ] Test error scenario: zero campaigns
- [ ] Test UI state transitions (Generating… → normal)

## Browser Compatibility

- Modern browsers supporting HTML5 Blob API
- Excel/Sheets support for `.xlsx` format
- Tested on: Chrome, Firefox, Safari (recent versions)

## Future Enhancements

1. **Filtered export** — export only campaigns from specific date range
2. **Campaign type filter** — export only STIK or KARDUS campaigns
3. **Selective sheet export** — choose which campaigns to include
4. **Custom formatting** — allow users to customize sheet names, column order
5. **Batch scheduling** — schedule exports to run daily/weekly
6. **Email delivery** — automatically email completed exports
7. **Incremental export** — export only new/updated campaigns since last export
