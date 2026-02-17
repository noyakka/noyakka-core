import { z } from "zod";
import type { NormalizedVapiArgs } from "./normalize";

const urgencySchema = z.enum([
  "emergency",
  "today",
  "this_week",
  "next_week",
  "quote_only",
]);

const windowSchema = z.enum(["morning", "arvo"]).optional();

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
  .optional();

const addressSchema = z
  .object({
    suburb: z.string().min(1).optional(),
    street_number: z.string().min(1).optional(),
    street_name: z.string().min(1).optional(),
    full: z.string().min(1).optional(),
  })
  .refine(
    (value) => Boolean(value.full || (value.street_number && value.street_name)),
    { message: "Address must include full or street number + street name" }
  );

export const vapiLightSchema = z.object({
  vendor_uuid: z.string().min(1),
  call_id: z.string().min(1).optional(),
  urgency: urgencySchema,
  window: windowSchema,
  date: dateSchema,
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  mobile: z.string().min(1).optional(),
  address: addressSchema.optional(),
  job_description: z.string().min(1).optional(),
});

export const vapiStrictSchema = vapiLightSchema.extend({
  mobile: z.string().min(1),
  address: addressSchema,
  job_description: z.string().min(1),
});

export const validateVapiLight = (input: NormalizedVapiArgs) => vapiLightSchema.parse(input);
export const validateVapiStrict = (input: NormalizedVapiArgs) => vapiStrictSchema.parse(input);

export const vapiPingSchema = z.object({
  vendor_uuid: z.string().min(1).optional(),
  call_id: z.string().min(1).optional(),
});

export const vapiCreateLeadSchema = vapiStrictSchema.extend({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email().optional(),
  call_summary: z.string().min(1).optional(),
});

export const vapiCreateJobSchema = vapiStrictSchema;

export const vapiSendSmsSchema = z.object({
  vendor_uuid: z.string().min(1),
  mobile: z.string().min(1),
  message: z.string().min(1),
  regarding_job_uuid: z.string().min(1).optional(),
});

export const vapiSendWindowSmsSchema = z.object({
  vendor_uuid: z.string().min(1),
  job_uuid: z.string().min(1),
  mobile: z.string().min(1),
  first_name: z.string().min(1),
  window_code: z.string().min(1),
  window_label: z.string().min(1),
});

export const vapiBookWindowSchema = z.object({
  vendor_uuid: z.string().min(1),
  job_uuid: z.string().min(1),
  mobile: z.string().min(1),
  first_name: z.string().min(1),
  selected_code: z.string().min(1),
});

export const vapiBookingBookWindowSchema = z.object({
  call_id: z.string().min(1).optional(),
  vendor_uuid: z.string().min(1),
  job_uuid: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  window: z.enum(["morning", "arvo"]).optional(),
  selected_code: z.string().min(1),
  allocation_window_uuid: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  const hasDateWindow = Boolean(value.date && value.window);
  const hasSelectedCode = Boolean(value.selected_code);
  if (!hasDateWindow && !hasSelectedCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selected_code"],
      message: "Provide selected_code or date+window",
    });
  }
});

export const vapiBookingCancelSchema = z.object({
  vendor_uuid: z.string().min(1),
  job_uuid: z.string().min(1),
});

export const vapiSendBookedSmsSchema = z.object({
  vendor_uuid: z.string().min(1),
  mobile: z.string().min(1),
  first_name: z.string().min(1),
  date_label: z.string().min(1),
  window_label: z.string().min(1),
  time_range: z.string().min(1),
  job_number: z.string().min(1),
  address: addressSchema,
  business_name: z.string().min(1).optional(),
  job_uuid: z.string().min(1).optional(),
});

export const vapiSendLoggedSmsSchema = z.object({
  vendor_uuid: z.string().min(1),
  mobile: z.string().min(1),
  first_name: z.string().min(1),
  job_number: z.string().min(1),
  address: addressSchema,
  business_name: z.string().min(1).optional(),
  job_uuid: z.string().min(1).optional(),
});

export const formatZodError = (error: z.ZodError) => {
  const missing_fields: string[] = [];
  const messageParts: string[] = [];

  for (const issue of error.issues) {
    const path = issue.path.join(".");
    if (issue.code === "invalid_type" && issue.received === "undefined") {
      if (path) {
        missing_fields.push(path);
      }
    } else {
      messageParts.push(path ? `${path}: ${issue.message}` : issue.message);
    }
  }

  return {
    message: messageParts.join("; ") || "Validation failed",
    missing_fields,
  };
};
