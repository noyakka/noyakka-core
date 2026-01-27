/*
  Warnings:

  - You are about to drop the column `company_uuid` on the `OAuthState` table. All the data in the column will be lost.
  - You are about to drop the column `company_uuid` on the `ServiceM8Connection` table. All the data in the column will be lost.
  - Added the required column `vendor_uuid` to the `ServiceM8Connection` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OAuthState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL,
    "vendor_uuid" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL
);
INSERT INTO "new_OAuthState" ("created_at", "expires_at", "id", "state") SELECT "created_at", "expires_at", "id", "state" FROM "OAuthState";
DROP TABLE "OAuthState";
ALTER TABLE "new_OAuthState" RENAME TO "OAuthState";
CREATE UNIQUE INDEX "OAuthState_state_key" ON "OAuthState"("state");
CREATE TABLE "new_ServiceM8Connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendor_uuid" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_ServiceM8Connection" ("access_token", "created_at", "expires_at", "id", "refresh_token", "updated_at") SELECT "access_token", "created_at", "expires_at", "id", "refresh_token", "updated_at" FROM "ServiceM8Connection";
DROP TABLE "ServiceM8Connection";
ALTER TABLE "new_ServiceM8Connection" RENAME TO "ServiceM8Connection";
CREATE UNIQUE INDEX "ServiceM8Connection_vendor_uuid_key" ON "ServiceM8Connection"("vendor_uuid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
