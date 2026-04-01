-- AlterTable
-- Adds replyPollEnabled toggle to AppConfig. Purely additive — existing rows get true (unchanged behaviour).
ALTER TABLE `AppConfig` ADD COLUMN `replyPollEnabled` BOOLEAN NOT NULL DEFAULT true;
