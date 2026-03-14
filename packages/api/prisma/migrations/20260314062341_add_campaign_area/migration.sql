/*
  Warnings:

  - You are about to drop the `CampaignDepartment` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `CampaignDepartment` DROP FOREIGN KEY `CampaignDepartment_campaignId_fkey`;

-- DropForeignKey
ALTER TABLE `CampaignDepartment` DROP FOREIGN KEY `CampaignDepartment_departmentId_fkey`;

-- DropTable
DROP TABLE `CampaignDepartment`;

-- CreateTable
CREATE TABLE `CampaignArea` (
    `campaignId` VARCHAR(191) NOT NULL,
    `areaId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`campaignId`, `areaId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CampaignArea` ADD CONSTRAINT `CampaignArea_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignArea` ADD CONSTRAINT `CampaignArea_areaId_fkey` FOREIGN KEY (`areaId`) REFERENCES `Area`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
