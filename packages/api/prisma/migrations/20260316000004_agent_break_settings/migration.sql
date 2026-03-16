-- AlterTable
ALTER TABLE `Agent` ADD COLUMN `breakEvery` INTEGER NULL,
    ADD COLUMN `breakMaxMs` INTEGER NULL,
    ADD COLUMN `breakMinMs` INTEGER NULL,
    MODIFY `phoneNumber` VARCHAR(191) NOT NULL;

