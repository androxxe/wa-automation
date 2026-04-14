# Manual Campaign Completion Feature Specification

## Overview
Add ability for users to manually set a campaign status to `COMPLETED` from the Campaign Details page. This is a destructive action that requires explicit confirmation to prevent accidental execution.

## Feature Requirements

### 1. User Interface
- **Location**: Campaign Details page controls section (line 728-776)
- **Button**: "Mark Complete" button displayed conditionally
- **Visibility Rules**:
  - Show when: Campaign status is `RUNNING` or `PAUSED`
  - Hide when: Campaign status is `DRAFT`, `COMPLETED`, or `CANCELLED`

### 2. Confirmation Flow
To prevent accidental completion, implement a two-step confirmation:

**Step 1: Initial Confirmation Dialog**
- Title: "Mark Campaign as Completed?"
- Content: Show campaign name and status
- Warning message: "This action is irreversible and will mark all remaining unsent/queued messages as completed."
- Two actions: "Cancel" and "Continue"

**Step 2: Campaign Name Re-entry Verification**
- After user clicks "Continue", show a modal with input field
- Label: "Type campaign name to confirm"
- Input: Text field where user must enter the exact campaign name
- Validation: Button only enabled when input matches campaign name exactly
- Three actions: "Cancel", "Clear", and "Confirm" (disabled until names match)
- Error message if names don't match (optional, when user tries to confirm)

### 3. API Integration
- **Endpoint**: `POST /api/campaigns/{id}/complete`
- **Expected Behavior**: Backend sets campaign status to `COMPLETED`
- **Error Handling**: Catch and display validation errors from backend

### 4. State Management
- **Mutation**: Create separate `completeMutation` using React Query
- **Loading State**: Show "Marking complete..." text while processing
- **Query Invalidation**: After success, invalidate:
  - `['campaigns']`
  - `['campaign', id]`

### 5. User Feedback
- **Success**: Alert confirming campaign marked as completed
- **Error**: Alert with error message from backend
- **UI Update**: Campaign status badge updates to blue (COMPLETED) automatically

## Implementation Details

### Modal Component Structure
```
CompleteCampaignModal
├── Dialog wrapper (fixed inset-0 z-50)
├── Two-step flow state
├── Step 1: Confirmation dialog
│   ├── Title & warning message
│   └── Cancel/Continue buttons
└── Step 2: Name verification
    ├── Input field for campaign name
    ├── Real-time validation feedback
    └── Cancel/Clear/Confirm buttons
```

### Styling
- Match existing modal patterns (FailReasonModal, ManualSendModal)
- Use Tailwind classes consistent with current design system
- Status colors: Warning state during confirmation

## Flow Diagram

```
User clicks "Mark Complete"
         ↓
Confirm Dialog (Step 1)
    ├─ Cancel → Close
    └─ Continue → Step 2
         ↓
Name Verification Dialog (Step 2)
    ├─ Cancel → Close
    ├─ Type name → Real-time validation
    └─ Confirm (enabled if names match)
         ↓
Call API: POST /api/campaigns/{id}/complete
         ↓
Success: Invalidate queries → Status updates to COMPLETED
Error: Show alert with error message
```

## Error Cases
1. Backend returns 400/403: Validation error (e.g., status already completed)
2. Backend returns 500: Server error
3. Campaign name doesn't match: Prevent confirmation
4. Network error: Show generic error message

## Rollback Considerations
- **Important**: This is an admin-level destructive action
- Consider adding audit logging on backend (who completed, when)
- No client-side rollback provided; user must contact admin to revert

## Related Components
- CampaignDetail.tsx: Main component (lines 508-975)
- Mutation pattern: Similar to `actionMutation` (lines 572-579)
- Modal pattern: Follows FailReasonModal and ManualSendModal structure
