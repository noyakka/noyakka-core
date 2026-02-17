export type OpsEventName =
  | "PROFIT_FLAGGED"
  | "OVERRUN_DETECTED"
  | "DELAY_SMS_SENT"
  | "MAJOR_DELAY_ALERT_SENT"
  | "ETA_30MIN_SENT"
  | "BOOKING_FAILED"
  | "BOOKING_ALLOCATION_CREATED";

export const logOpsEvent = (
  logger: { info: (meta: unknown, message?: string) => void },
  event: OpsEventName,
  payload: Record<string, unknown>
) => {
  logger.info(
    {
      event,
      ...payload,
    },
    "Operational event"
  );
};
