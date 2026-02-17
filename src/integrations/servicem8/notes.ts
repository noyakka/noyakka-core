import { getServiceM8Client } from "../../lib/servicem8-oauth";

export const appendJobRiskNote = async (input: {
  vendor_uuid: string;
  job_uuid: string;
  allocation_uuid?: string;
  noteText: string;
  staff_uuid?: string;
}) => {
  const sm8 = await getServiceM8Client(input.vendor_uuid);
  const payload: Record<string, unknown> = {
    job_uuid: input.job_uuid,
    type: "note",
    note: input.noteText,
  };
  if (input.staff_uuid) {
    payload.staff_uuid = input.staff_uuid;
  }
  if (input.allocation_uuid) {
    payload.allocation_uuid = input.allocation_uuid;
  }
  return sm8.postJson("/jobactivity.json", payload);
};
