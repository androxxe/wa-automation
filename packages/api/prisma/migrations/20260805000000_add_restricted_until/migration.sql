-- Add restrictedUntil to Agent — when the current WhatsApp restriction is
-- expected to lift (null = not restricted). Purely additive.
ALTER TABLE `Agent` ADD COLUMN `restrictedUntil` DATETIME(3) NULL;
