# Department-Based Report Specification

## Overview

Create a new export format that organizes data by **Department** (as sheets) with **Campaign tables** inside each department sheet, separated by one empty row between tables.

This provides a hierarchical view: Department → Multiple Campaigns → Data rows

## Filter Options

Users can control which data rows appear in the report using the following filters:

### Category Filter (Claude Category)

**Available Options:**
- ✓ Confirmed
- ✓ Denied
- ✓ Question
- ✓ Unclear
- ✓ Invalid
- ✓ Other
- ✓ (empty/no reply)

**Default:** All selected

**Behavior:**
- When a category is unchecked, all rows with that category are excluded from the report
- If a contact has no reply (empty category), include/exclude via "(empty/no reply)" checkbox
- Example: Uncheck "Invalid" → no rows with `claudeCategory = 'invalid'` appear

### Status Filter (Reply Status)

**Available Options:**
- ✓ Valid (replied)
- ✓ Invalid (replied but marked invalid)
- ✓ Pending (no reply yet)

**Default:** All selected

**Behavior:**
- "Valid": Show only contacts that have a reply and category ≠ 'invalid'
- "Invalid": Show only contacts that have a reply but category = 'invalid'
- "Pending": Show only contacts that have no reply yet
- These are mutually exclusive states (a contact is in exactly one state)

### Jawaban Filter (Response Value)

**Available Options:**
- ✓ 1 (Ya)
- ✓ 0 (Tidak)
- ✓ Tidak Jelas (null)

**Default:** All selected

**Behavior:**
- "1": Show only rows where `jawaban = 1` (customer confirmed "Ya")
- "0": Show only rows where `jawaban = 0` (customer confirmed "Tidak")
- "Tidak Jelas": Show only rows where `jawaban = null` (customer reply was unclear/ambiguous)

**Important Distinction:**
- These filters only apply to contacts that **HAVE received a reply**
- For a contact with NO reply yet, `jawaban` is `null` but they won't match any of these
- Use **Status Filter "Pending"** to see contacts with NO reply at all
- Use **Category Filter "(No Reply)"** to also see contacts with no replies

### UI Layout (Export Page)

```
┌─ Filter Section ─────────────────────┐
│                                      │
│ [Month Filter] [Type Filter]         │
│                                      │
│ ┌─ Category Filters ──────────────┐  │
│ │ ☑ Confirmed ☑ Denied ☑ Question│  │
│ │ ☑ Unclear   ☑ Invalid ☑ Other  │  │
│ │ ☑ (No Reply)                   │  │
│ └────────────────────────────────┘  │
│                                      │
│ ┌─ Status Filters ────────────────┐  │
│ │ ☑ Valid  ☑ Invalid  ☑ Pending  │  │
│ └────────────────────────────────┘  │
│                                      │
│ ┌─ Jawaban Filters ───────────────┐  │
│ │ ☑ 1 (Ya)  ☑ 0 (Tidak) ☑ Tidak Jelas│ │
│ └────────────────────────────────┘  │
│                                      │
│ ┌─ Export Type ───────────────────┐  │
│ │ ◉ Campaign-Based (existing)     │  │
│ │ ○ Department-Based (new)        │  │
│ └────────────────────────────────┘  │
│                                      │
└──────────────────────────────────────┘
```

### Filter Logic

**AND/OR Logic:**

- **Within a filter group** (Category, Status, Jawaban): **OR** logic
  - Example: "Show Confirmed OR Denied" → Category in (confirmed, denied)

- **Between filter groups**: **AND** logic
  - Example: "Category=(Confirmed OR Denied) AND Status=Valid AND Jawaban=1"
  - Result: Confirmed AND Valid AND Ya, OR Denied AND Valid AND Ya

**Database Query Representation:**

```sql
WHERE 
  (claudeCategory IN ('confirmed', 'denied'))  -- Category filter (OR)
  AND
  (status IN ('valid', 'invalid'))              -- Status filter (OR)
  AND
  (jawaban IN (1))                              -- Jawaban filter (OR)
```

### Summary Sheet Impact

The Summary sheet should reflect **only the filtered data**:

```
Department Summary Table:
  Department | Campaigns | Total Rows (filtered) | Valid | Invalid

Campaign Details (listing only campaigns that have matching rows):
  Campaign A — Januari — STIK (X rows after filtering)
  Campaign B — Februari — KARDUS (Y rows after filtering)
```

### Empty Results Handling

**If filtering removes all rows from a campaign:**
- Still show the campaign title row
- But don't show the header row
- Show message: "No matching records for this campaign"
- Or: Skip the campaign entirely (cleaner output)

**Recommendation:** Skip campaigns with no matching rows

**If filtering removes all rows from a department:**
- Skip the entire department sheet
- Don't create empty sheets
- Update Summary sheet to show only departments with data

## Comparison: Current vs New Format

### Current Multi-Campaign Export
```
Excel Workbook
├── Sheet: "Campaign_1_20250415"
│   └── All rows for Campaign 1
├── Sheet: "Campaign_2_20250415"
│   └── All rows for Campaign 2
├── Sheet: "Campaign_3_20250415"
│   └── All rows for Campaign 3
└── Sheet: "Summary"
    └── Global statistics
```

### New Department-Based Format
```
Excel Workbook
├── Sheet: "Department 1"
│   ├── Campaign 1 Header
│   ├── Campaign 1 Data Rows
│   ├── [1 Empty Row Separator]
│   ├── Campaign 2 Header
│   ├── Campaign 2 Data Rows
│   ├── [1 Empty Row Separator]
│   ├── Campaign 3 Header
│   └── Campaign 3 Data Rows
├── Sheet: "Department 2"
│   ├── Campaign 4 Header
│   ├── Campaign 4 Data Rows
│   └── ...
└── Sheet: "Summary"
    └── Department statistics
```

## Data Structure

### Sheet Organization

**Sheets per Department:**
- One sheet per department (e.g., "Department 1", "Department 2", etc.)
- Sheet name: Truncated to 31 characters if needed
- Order: Alphabetical by department name

**Content per Department Sheet:**

```
[Campaign 1 Header Row]
  Column Headers (bold, gray background)
  
[Campaign 1 Data Rows]
  Row 1: Contact data
  Row 2: Contact data
  ...
  
[Empty Row Separator]

[Campaign 2 Header Row]
  Column Headers (bold, gray background)
  
[Campaign 2 Data Rows]
  Row 1: Contact data
  Row 2: Contact data
  ...
  
[Empty Row Separator]

[Campaign 3 Header Row]
  Column Headers (bold, gray background)
  
[Campaign 3 Data Rows]
  Row 1: Contact data
  ...
```

### Column Headers (Per Campaign Table)

**Updated Column Order and Names:**

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Market | String | Area name (renamed from "Area") |
| 2 | No | Integer | Row number within campaign table |
| 3 | Nama Toko | String | Store name |
| 4 | No HP | String | Phone number (renamed from "Nomor HP Toko") |
| 5 | Agent Phone | String | Sending agent phone |
| 6 | Produk {{bulan}} Terjual | Integer | 1 (Ya), 0 (Tidak), empty (Pending) - renamed with dynamic month |
| 7 | Kategori | String | Claude category |
| 8 | Status | String | "Valid", "⚠ Invalid", or empty |
| 9 | Dikirim pada | DateTime | Send timestamp |
| 10 | Dibalas pada | DateTime | Reply timestamp |
| 11 | Raw Response | String | Full reply text |
| 12 | Screenshot | Image | Embedded screenshot |

**Column Rename Details:**

- **"Area" → "Market"** (Column 1) - More business-friendly terminology
- **"Nomor HP Toko" → "No HP"** (Column 4) - Shorter, clearer
- **"Jawaban" → "Produk {{bulan}} Terjual"** (Column 6)
  - Dynamic header based on campaign month
  - Example if bulan="Januari": "Produk Januari Terjual"
  - Example if bulan="02": "Produk 02 Terjual"
  - Still shows 1 (Ya), 0 (Tidak), empty (Pending)

**Note:** "Department" column removed (implicit in sheet name)

### Campaign Header Row

Before each campaign's data, add a header row with campaign metadata:

```
[Row N] [Empty] | {Campaign Name} — {Bulan} — {CampaignType} | [Empty] | ... [Empty]
```

- Merged across columns 1-5 (or full row)
- Font: Bold, size 11, slightly larger than normal
- Background: Light blue or accent color
- Provides visual separation and campaign identification

### Summary Sheet

Contains department-level statistics:

```
Row 1: "Laporan AICE WhatsApp Automation — Per Department" (bold, size 13)
Row 2: [Empty]
Row 3: Generated: {timestamp}
Row 4: [Empty]
Row 5: Department Summary Table:
       [Column Headers: Department | Campaigns | Total Rows | Valid | Invalid]
       [Row for each department with stats]
Row N: [Empty]
Row N+1: Campaign Details:
         [List all campaigns by department]
```

## Implementation Details

### Backend Function

**New Function:** `buildDepartmentReportXlsx(filters?: { bulan?: string; campaignType?: string; categories?: string[]; statuses?: string[]; jawabans?: (0 | 1 | null)[] })`

Location: `packages/api/src/lib/report-xlsx.ts`

**Filter Parameters:**

```typescript
interface ExportFilters {
  // Campaign filters
  bulan?: string                    // e.g., "Januari"
  campaignType?: string             // e.g., "STIK" | "KARDUS"
  
  // Data row filters
  categories?: string[]             // e.g., ["confirmed", "denied", "invalid", "question", "unclear", "other", ""]
                                    // Empty string "" = no reply
  statuses?: string[]               // e.g., ["valid", "invalid", "pending"]
                                    // "valid" = has reply & category != invalid
                                    // "invalid" = has reply & category == invalid
                                    // "pending" = no reply
  jawabans?: (0 | 1 | null)[]       // e.g., [1, 0]
                                    // null = no reply (Pending)
}
```

**Algorithm (Updated):

```
1. Fetch all campaigns matching filters
   - Include areas with department relation
   
2. Group campaigns by department (Map structure)
   {
     "Department 1": [Campaign1, Campaign2, ...],
     "Department 2": [Campaign3, Campaign4, ...],
   }
   
3. For each department (alphabetically ordered):
   a. Create worksheet with department name
   b. Initialize row tracker: currentRow = 1
   
   c. For each campaign in department:
      i.   Add campaign metadata row (title)
           - Format: Bold, blue background
           - Row height: 20pt
           - Content: "{Campaign.name} — {Campaign.bulan} — {Campaign.campaignType}"
      
      ii.  Add header row (columns)
           - Format: Bold, gray background, centered
           - Columns: No, Nama Toko, Nomor HP, Area, Agent Phone, Jawaban, Kategori, Status, etc.
      
       iii. For each contact with message in campaign + department:
            - Check if row matches data filters (categories, statuses, jawabans)
            - If matches:
              - Add data row
              - Apply formatting (colors, alignment, embedded images)
              - Increment row tracker
            - If doesn't match: Skip row
       
       iv.  After all contacts for campaign:
            - If no rows were added (all filtered out):
              - Option A: Skip campaign (cleaner)
              - Option B: Show "No matching records" message
              - Recommendation: Use Option A
            - If rows were added:
              - Add 1 empty row separator
              - Increment row tracker by 1
       
       v.   Move to next campaign
    
    d. Remove last empty row (trailing separator)
    
    e. If no campaigns had matching rows:
       - Skip entire department sheet
       - Don't add empty sheets

4. Generate Summary sheet with department stats

5. Return workbook as buffer
```

**Function Signature:**

```typescript
export async function buildDepartmentReportXlsx(
  filters?: { 
    bulan?: string
    campaignType?: string 
  }
): Promise<Buffer>
```

### API Endpoint

**New Endpoint:** `GET /api/export/report-xlsx-dept`

Location: `packages/api/src/routes/export.ts`

**Query Parameters:**
- `bulan` (optional) - Filter by month (string)
- `campaignType` (optional) - Filter by campaign type (string)
- `categories` (optional) - Comma-separated category names (string)
  - Values: `confirmed,denied,question,unclear,invalid,other,` (empty string for no reply)
  - Default: All categories included
  - Example: `?categories=confirmed,denied,invalid`
- `statuses` (optional) - Comma-separated status values (string)
  - Values: `valid,invalid,pending`
  - Default: All statuses included
  - Example: `?statuses=valid,pending`
- `jawabans` (optional) - Comma-separated jawaban values (string)
  - Values: `1,0,null`
  - Default: All jawabans included
  - Example: `?jawabans=1,0` (exclude pending)

**Example URLs:**

```
GET /api/export/report-xlsx-dept
  → All data, all filters

GET /api/export/report-xlsx-dept?bulan=Januari&campaignType=STIK
  → January STIK campaigns only

GET /api/export/report-xlsx-dept?categories=confirmed,denied
  → Only confirmed and denied replies

GET /api/export/report-xlsx-dept?statuses=valid
  → Only valid replies (exclude invalid and pending)

GET /api/export/report-xlsx-dept?jawabans=1
  → Only "Ya" responses

GET /api/export/report-xlsx-dept?bulan=Januari&categories=invalid&statuses=invalid
  → January, invalid category, invalid status
```

**Response Headers:**
```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="laporan_per_department_{YYYY-MM-DD}.xlsx"
```

**Filename Generation:**
- No filters: `laporan_per_department_2025-04-15.xlsx`
- Month only: `laporan_per_department_Januari_2025-04-15.xlsx`
- Type only: `laporan_per_department_STIK_2025-04-15.xlsx`
- Both: `laporan_per_department_Januari_STIK_2025-04-15.xlsx`
- Data filters don't affect filename (implied in content)

### Frontend Update

**Export Page Update:** `packages/web/src/pages/Export.tsx`

**UI Structure:**

```
┌─────────────────────────────────────────────┐
│ Export Reports                              │
│                                             │
│ [Month Filter] [Type Filter]                │
│                                             │
│ ┌─ Category Filters ───────────────────┐   │
│ │ □ Confirmed  □ Denied    □ Question │   │
│ │ □ Unclear    □ Invalid   □ Other    │   │
│ │ □ (No Reply)                        │   │
│ └─────────────────────────────────────┘   │
│                                             │
│ ┌─ Status Filters ─────────────────────┐   │
│ │ □ Valid      □ Invalid   □ Pending  │   │
│ └─────────────────────────────────────┘   │
│                                             │
│ ┌─ Response Filters ───────────────────┐   │
│ │ □ 1 (Ya)     □ 0 (Tidak) □ Pending  │   │
│ └─────────────────────────────────────┘   │
│                                             │
│ ┌─ Export Type ────────────────────────┐   │
│ │ ◉ Campaign-Based (existing)         │   │
│ │ ○ Department-Based (new)            │   │
│ └─────────────────────────────────────┘   │
│                                             │
│ [Preview showing X campaigns, Y rows]      │
│ [Download XLSX Report Button]              │
│                                             │
└─────────────────────────────────────────────┘
```

**Component Changes:**

1. **New State Variables** (Export.tsx):
   ```typescript
   const [selectedCategories, setSelectedCategories] = useState<string[]>(
     ['confirmed', 'denied', 'question', 'unclear', 'invalid', 'other', '']
   )
   const [selectedStatuses, setSelectedStatuses] = useState<string[]>(
     ['valid', 'invalid', 'pending']
   )
   const [selectedJawabans, setSelectedJawabans] = useState<(0 | 1 | null)[]>(
     [1, 0, null]
   )
   const [exportType, setExportType] = useState<'campaign' | 'department'>('campaign')
   ```

2. **Filter UI Components:**
   - Category checkboxes (multi-select)
   - Status checkboxes (multi-select)
   - Jawaban checkboxes (multi-select)
   - Export type radio buttons

3. **Preview Logic:**
   - Show filtered row count
   - Show which categories/statuses/jawabans are active
   - Live update as filters change

4. **Download Handler:**
   ```typescript
   const handleDownload = async () => {
     const params = new URLSearchParams()
     
     // Campaign filters
     if (selectedMonth) params.append('bulan', selectedMonth)
     if (selectedType) params.append('campaignType', selectedType)
     
     // Data filters
     if (selectedCategories.length < 7) { // 7 = all options
       params.append('categories', selectedCategories.join(','))
     }
     if (selectedStatuses.length < 3) { // 3 = all options
       params.append('statuses', selectedStatuses.join(','))
     }
     if (selectedJawabans.length < 3) { // 3 = all options
       params.append('jawabans', selectedJawabans.join(','))
     }
     
     const endpoint = exportType === 'department'
       ? '/api/export/report-xlsx-dept'
       : '/api/export/report-xlsx-filtered'
     
     const res = await fetch(`${endpoint}?${params}`)
     // ... handle download
   }
   ```

**Export Button Update:**

Add new button/option:
```
[Button] "Department-Based Report"
```
- Placed below "Download XLSX Report" button (or as radio option)
- Same filters applied
- Same preview logic
- Handler: Calls appropriate endpoint based on export type

## Formatting Details

### Column Widths

| Column | Width |
|--------|-------|
| Market | 20 |
| No | 5 |
| Nama Toko | 28 |
| No HP | 15 |
| Agent Phone | 18 |
| Produk {{bulan}} Terjual | 15 |
| Kategori | 14 |
| Status | 12 |
| Dikirim pada | 20 |
| Dibalas pada | 20 |
| Raw Response | 40 |
| Screenshot | 32 |

### Dynamic Column Header Implementation

**Column Header for Jawaban:**

The column header for "Jawaban" is dynamically generated based on the campaign's `bulan` value:

```
Header Template: "Produk {{bulan}} Terjual"

Examples:
- If campaign.bulan = "Januari"  → "Produk Januari Terjual"
- If campaign.bulan = "Februari" → "Produk Februari Terjual"
- If campaign.bulan = "01"       → "Produk 01 Terjual"
- If campaign.bulan = "March"    → "Produk March Terjual"
```

**Implementation:**

```typescript
// In buildDepartmentReportXlsx() when creating header row:
const jawabanHeader = `Produk ${campaign.bulan} Terjual`

headers = [
  'Market',
  'No',
  'Nama Toko',
  'No HP',
  'Agent Phone',
  jawabanHeader,  // Dynamic based on campaign
  'Kategori',
  'Status',
  'Dikirim pada',
  'Dibalas pada',
  'Raw Response',
  'Screenshot'
]
```

**Backend Processing:**

- Each campaign table will have its own header row
- Different campaigns may have different month values
- The Jawaban column header will reflect the specific campaign's month
- Data in the Jawaban column remains the same (1, 0, or empty)

### Cell Styling

**Campaign Title Row:**
- Font: Bold, size 11
- Fill: Light blue (e.g., `FF3B82F6`)
- Alignment: Left, vertical middle
- Height: 20pt
- Borders: None or light border

**Header Row (per campaign):**
- Font: Bold, color: `FF1F2937`, size: 10
- Fill: Gray (`FFE5E7EB`)
- Alignment: Center, vertical middle
- Height: 22pt
- Border: Bottom medium, color: `FFD1D5DB`

**Data Rows:**
- Jawaban cell: Bold green (1) or bold red (0), no fill
- Kategori cell: Color-coded background, centered
- Status cell: Red for invalid, green for valid
- Even rows: Light gray background (`FFFAFAFA`) for rows 1-6 only
- Screenshot: Embedded at 240×180px

**Empty Separator Row:**
- Height: 6pt
- No content
- No styling

### Image Handling
- Embedded screenshots in column 12 (Screenshot)
- Size: 240×180px
- Row height auto-adjusted: `Math.ceil(180 * 0.75) + 6 = 141pt`
- If image missing: Show file path in italic gray text

## Data Fetching Strategy

### Query Approach

```typescript
// Get all campaigns matching filters
const campaigns = await db.campaign.findMany({
  where: { /* filters */ },
  include: {
    areas: {
      include: {
        area: {
          include: { department: true }
        }
      }
    }
  }
})

// Group by department
const byDept: Map<string, Campaign[]> = new Map()
for (const campaign of campaigns) {
  for (const ca of campaign.areas) {
    const deptName = ca.area.department.name
    if (!byDept.has(deptName)) {
      byDept.set(deptName, [])
    }
    if (!byDept.get(deptName)!.some(c => c.id === campaign.id)) {
      byDept.get(deptName)!.push(campaign)
    }
  }
}

// Sort departments alphabetically
const sortedDepts = Array.from(byDept.keys()).sort()
```

### Contact Fetching

For each campaign + department combination:

```typescript
const contacts = await db.contact.findMany({
  where: {
    areaId: area.id,
    phoneValid: true
  },
  include: {
    messages: {
      where: {
        campaignId: campaign.id,
        status: { in: ['SENT', 'DELIVERED', 'READ'] }
      },
      include: {
        reply: true,
        agent: { select: { phoneNumber: true } }
      },
      orderBy: { sentAt: 'desc' },
      take: 1
    }
  },
  orderBy: [{ seqNo: 'asc' }, { storeName: 'asc' }]
})
```

## Database Queries Summary

1. **Fetch campaigns** - 1 query (with areas + department relations)
2. **Fetch contacts per campaign per department** - N queries (N = departments × campaigns)
3. **Image files** - Read from filesystem per screenshot

**Optimization Opportunity:** Batch contact fetches using Promise.all()

## Performance Considerations

### Memory Usage
- Campaigns grouped in memory
- Contacts fetched per campaign (not all at once)
- Screenshots loaded individually
- Typical: 100-500MB for 10-20 campaigns across 9 departments

### Query Count
- Initial: 1 campaign query
- Per department/campaign combo: 1 contact query
- Worst case: 9 departments × 20 campaigns = 189 queries
- **Recommendation:** Implement batch query optimization

### File Size
- Smaller than campaign-based (no duplicate headers)
- Compression: ~50% reduction expected
- Typical: 50-200MB per export

## Testing Checklist

- [ ] Export creates correct sheets per department
- [ ] Each department sheet contains all its campaigns
- [ ] Campaign tables separated by 1 empty row
- [ ] Campaign title row formatted correctly (bold, blue)
- [ ] Column headers present and styled
- [ ] Jawaban shows 1/0 with correct colors
- [ ] Screenshots embedded
- [ ] Summary sheet shows department stats
- [ ] Filters work correctly (month, type)
- [ ] Filename generated correctly
- [ ] No duplicate campaigns in sheet
- [ ] Empty rows not at beginning/end
- [ ] Cell alignment and borders correct
- [ ] Test with 0 campaigns (error handling)
- [ ] Test with 1 department (single sheet)
- [ ] Test with mixed campaign types in one department

## User Experience

### Before Implementation
- User navigates to Export page
- Selects filters
- Clicks "Download XLSX Report" → Gets campaigns per sheet

### After Implementation
- User navigates to Export page
- Selects filters
- Two options:
  1. **"Download XLSX Report"** → Campaigns per sheet (existing)
  2. **"Department-Based Report"** → Departments per sheet (new)

**Recommended Usage:**
- **Campaign-based:** Reviewing individual campaign performance
- **Department-based:** Manager reviewing department-wide results across multiple campaigns

## Migration Path

1. Implement new function without removing old one (backward compatible)
2. Add new API endpoint
3. Update Export page with new button
4. Keep existing export functionality untouched
5. Monitor user adoption before deprecating old format

## Future Enhancements

1. **Area-based Report** - Sheets per area instead of department
2. **Combined View** - Department sheet with area subsections
3. **Drill-down Links** - Campaign title links to campaign page (if desktop app)
4. **Custom Grouping** - User selects grouping level (dept/area/campaign)
5. **Scheduled Exports** - Auto-generate reports daily/weekly
6. **Email Distribution** - Automatically email to department heads
