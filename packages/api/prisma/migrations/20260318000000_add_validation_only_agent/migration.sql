-- AlterTable
-- Adds validationOnly flag to Agent. Purely additive — existing rows get false (unchanged behaviour).
ALTER TABLE `Agent` ADD COLUMN `validationOnly` BOOLEAN NOT NULL DEFAULT false;
