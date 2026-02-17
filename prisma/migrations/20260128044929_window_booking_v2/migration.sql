/*
  Warnings:

  - You are about to drop the column `capacity_max` on the `WindowCapacity` table. All the data in the column will be lost.
  - You are about to drop the column `confirmed_count` on the `WindowCapacity` table. All the data in the column will be lost.
  - You are about to drop the column `holds_count` on the `WindowCapacity` table. All the data in the column will be lost.
  - Added the required column `max_capacity` to the `WindowCapacity` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
DROP TABLE IF EXISTS "VendorConfig";
CREATE TABLE "VendorConfig" (
    "servicem8_vendor_uuid" TEXT NOT NULL PRIMARY KEY,
    "business_name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Brisbane',
    "morning_capacity" INTEGER NOT NULL,
    "arvo_capacity" INTEGER NOT NULL,
    "emergency_reserve" INTEGER NOT NULL DEFAULT 2,
    "working_days" TEXT NOT NULL DEFAULT '["mon","tue","wed","thu","fri"]',
    "cutoff_today_arvo" TEXT NOT NULL DEFAULT '14:30',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
DROP TABLE IF EXISTS "AllocationWindowMap";
CREATE TABLE "AllocationWindowMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "servicem8_vendor_uuid" TEXT NOT NULL,
    "morning_window_uuid" TEXT,
    "arvo_window_uuid" TEXT,
    "raw_windows_json" TEXT,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
DROP TABLE IF EXISTS "JobWindowBooking";
CREATE TABLE "JobWindowBooking" (
    "job_uuid" TEXT NOT NULL PRIMARY KEY,
    "servicem8_vendor_uuid" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "allocation_uuid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS "new_WindowCapacity";
CREATE TABLE "new_WindowCapacity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "servicem8_vendor_uuid" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "max_capacity" INTEGER NOT NULL,
    "booked_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_WindowCapacity" ("created_at", "date", "id", "servicem8_vendor_uuid", "updated_at", "window", "max_capacity", "booked_count")
SELECT "created_at", "date", "id", "servicem8_vendor_uuid", "updated_at", "window", "capacity_max", "holds_count" + "confirmed_count" FROM "WindowCapacity";
DROP TABLE "WindowCapacity";
ALTER TABLE "new_WindowCapacity" RENAME TO "WindowCapacity";
CREATE UNIQUE INDEX "WindowCapacity_servicem8_vendor_uuid_date_window_key" ON "WindowCapacity"("servicem8_vendor_uuid", "date", "window");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AllocationWindowMap_servicem8_vendor_uuid_key" ON "AllocationWindowMap"("servicem8_vendor_uuid");
