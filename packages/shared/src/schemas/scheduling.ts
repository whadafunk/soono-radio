import { z } from 'zod';

// ============ CUSTOMERS ============

export const CustomerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const CustomerCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;

export const CustomerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type CustomerPatch = z.infer<typeof CustomerPatchSchema>;

// ============ CONTRACTS ============

export const PRIORITY_LEVELS = ['hard', 'standard', 'soft'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const ContractSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  name: z.string(),
  starts_on: z.string(), // ISO date "2026-06-01"
  ends_on: z.string(),
  plays_per_month: z.number().int().positive(),
  time_window_start: z.string().nullable(), // "06:00"
  time_window_end: z.string().nullable(), // "22:00"
  days_of_week: z.string().nullable(), // "1,2,3,4,5"
  separation_minutes: z.number().int().nonnegative().default(90),
  advertiser_separation_min: z.number().int().nonnegative().default(30),
  priority: z.enum(PRIORITY_LEVELS).default('standard'),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Contract = z.infer<typeof ContractSchema>;

export const ContractCreateSchema = z.object({
  customer_id: z.number().int().positive(),
  name: z.string().min(1, 'Contract name is required'),
  starts_on: z.string().min(1, 'Start date required'),
  ends_on: z.string().min(1, 'End date required'),
  plays_per_month: z.number().int().positive('Must be at least 1'),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  days_of_week: z.string().nullable().optional(),
  separation_minutes: z.number().int().nonnegative().default(90),
  advertiser_separation_min: z.number().int().nonnegative().default(30),
  priority: z.enum(PRIORITY_LEVELS).default('standard'),
  notes: z.string().nullable().optional(),
});
export type ContractCreate = z.infer<typeof ContractCreateSchema>;

export const ContractPatchSchema = z.object({
  name: z.string().min(1).optional(),
  starts_on: z.string().optional(),
  ends_on: z.string().optional(),
  plays_per_month: z.number().int().positive().optional(),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  days_of_week: z.string().nullable().optional(),
  separation_minutes: z.number().int().nonnegative().optional(),
  advertiser_separation_min: z.number().int().nonnegative().optional(),
  priority: z.enum(PRIORITY_LEVELS).optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type ContractPatch = z.infer<typeof ContractPatchSchema>;

// Contract with customer name denormalized for display
export const ContractWithCustomerSchema = ContractSchema.extend({
  customer_name: z.string(),
});
export type ContractWithCustomer = z.infer<typeof ContractWithCustomerSchema>;

// Pacing info for a contract
export const ContractPacingSchema = z.object({
  plays_this_month: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  pct: z.number().min(0).max(100),
  on_track: z.boolean(),
});
export type ContractPacing = z.infer<typeof ContractPacingSchema>;

// ============ CONTACTS ============

export const ContactSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable(), // "Account Manager", "Technical Contact", etc.
  notes: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ContactCreateSchema = z.object({
  customer_id: z.number().int().positive(),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactCreate = z.infer<typeof ContactCreateSchema>;

export const ContactPatchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactPatch = z.infer<typeof ContactPatchSchema>;
