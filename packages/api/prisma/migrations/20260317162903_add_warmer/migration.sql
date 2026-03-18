-- AlterTable
ALTER TABLE `Agent` ADD COLUMN `isWarmed` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `warmMode` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `warmedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `WarmSession` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'IDLE',
    `totalExchanges` INTEGER NOT NULL,
    `doneExchanges` INTEGER NOT NULL DEFAULT 0,
    `partialFailure` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WarmSessionAgent` (
    `warmSessionId` VARCHAR(191) NOT NULL,
    `agentId` INTEGER NOT NULL,

    PRIMARY KEY (`warmSessionId`, `agentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WarmExchange` (
    `id` VARCHAR(191) NOT NULL,
    `warmSessionId` VARCHAR(191) NOT NULL,
    `senderAgentId` INTEGER NOT NULL,
    `recipientAgentId` INTEGER NOT NULL,
    `message` TEXT NOT NULL,
    `replyMessage` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `sentAt` DATETIME(3) NULL,
    `repliedAt` DATETIME(3) NULL,
    `failReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WarmSessionAgent` ADD CONSTRAINT `WarmSessionAgent_warmSessionId_fkey` FOREIGN KEY (`warmSessionId`) REFERENCES `WarmSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WarmSessionAgent` ADD CONSTRAINT `WarmSessionAgent_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WarmExchange` ADD CONSTRAINT `WarmExchange_warmSessionId_fkey` FOREIGN KEY (`warmSessionId`) REFERENCES `WarmSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
