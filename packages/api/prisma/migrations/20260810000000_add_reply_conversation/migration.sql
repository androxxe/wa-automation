-- Add conversation to Reply — append-only outbound reply thread
-- (operator-sent replies to the contact, each with status SENT/FAILED/BLOCKED).
-- Purely additive.
ALTER TABLE `Reply` ADD COLUMN `conversation` JSON NULL;
