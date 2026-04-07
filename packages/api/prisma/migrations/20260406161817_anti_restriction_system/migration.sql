-- AlterTable
ALTER TABLE `Agent` ADD COLUMN `lastRestrictedAt` DATETIME(3) NULL,
    ADD COLUMN `restrictionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `warmDaysCompleted` INTEGER NOT NULL DEFAULT 0;
