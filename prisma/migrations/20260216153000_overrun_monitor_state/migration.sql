-- CreateTable
CREATE TABLE "OverrunMonitorState" (
    "allocation_uuid" TEXT NOT NULL PRIMARY KEY,
    "job_uuid" TEXT,
    "staff_uuid" TEXT,
    "allocation_date" TEXT,
    "overrun_detected_at" DATETIME,
    "delay_minutes" INTEGER,
    "delay_sms_sent_at" DATETIME,
    "thirty_away_sms_sent_at" DATETIME,
    "major_alert_sent_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
