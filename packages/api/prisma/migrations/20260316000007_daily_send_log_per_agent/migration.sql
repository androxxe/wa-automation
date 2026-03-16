-- DailySendLog was previously a single global counter (no agentId).
-- Drop and recreate with per-agent tracking (agentId + date compound unique).
-- Dev data only — fresh start is acceptable.

DROP TABLE IF EXISTS `DailySendLog`;

CREATE TABLE `DailySendLog` (
  `id`        VARCHAR(191) NOT NULL,
  `agentId`   INTEGER NOT NULL,
  `date`      VARCHAR(191) NOT NULL,
  `count`     INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,
  CONSTRAINT `DailySendLog_pkey` PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `DailySendLog_agentId_date_key` ON `DailySendLog`(`agentId`, `date`);

ALTER TABLE `DailySendLog` ADD CONSTRAINT `DailySendLog_agentId_fkey`
  FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
