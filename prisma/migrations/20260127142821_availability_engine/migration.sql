-- CreateTable
CREATE TABLE "BusinessConfig" (
    "servicem8_vendor_uuid" TEXT NOT NULL PRIMARY KEY,
    "business_name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Brisbane',
    "cutoff_time" TEXT NOT NULL DEFAULT '14:30',
    "window_morning_start" TEXT NOT NULL DEFAULT '08:00',
    "window_morning_end" TEXT NOT NULL DEFAULT '12:00',
    "window_arvo_start" TEXT NOT NULL DEFAULT '13:00',
    "window_arvo_end" TEXT NOT NULL DEFAULT '16:00',
    "capacity_per_window" INTEGER NOT NULL DEFAULT 6,
    "emergency_reserve" INTEGER NOT NULL DEFAULT 2,
    "holds_ttl_minutes" INTEGER NOT NULL DEFAULT 15,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WindowCapacity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "servicem8_vendor_uuid" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "capacity_max" INTEGER NOT NULL,
    "holds_count" INTEGER NOT NULL DEFAULT 0,
    "confirmed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WindowHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "servicem8_vendor_uuid" TEXT NOT NULL,
    "job_uuid" TEXT NOT NULL,
    "customer_mobile" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "WindowCapacity_servicem8_vendor_uuid_date_window_key" ON "WindowCapacity"("servicem8_vendor_uuid", "date", "window");
