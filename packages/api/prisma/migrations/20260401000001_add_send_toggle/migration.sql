-- AlterTable
-- Adds sendEnabled toggle to AppConfig. Purely additive — existing rows get true (unchanged behaviour).
ALTER TABLE `AppConfig` ADD COLUMN `sendEnabled` BOOLEAN NOT NULL DEFAULT true;
