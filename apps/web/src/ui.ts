/**
 * Shared UI constants — single source of truth for recurring Tailwind patterns.
 *
 * Usage: import { BTN_PRIMARY, INPUT, LABEL } from '../../ui';
 *
 * Rules:
 *   - Only add a constant when the same visual pattern appears in 3+ places.
 *   - Do not encode layout concerns (width, margin) — those belong at the call site.
 *   - Icons/gap inside buttons are fine to add via cx() at the call site.
 */

// ---------------------------------------------------------------------------
// Buttons
// Two sizes: md (toolbar / modal actions) · sm (compact inline controls)
// Four intents: primary · secondary · destructive · ghost
// ---------------------------------------------------------------------------

export const BTN_PRIMARY =
  'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BTN_SECONDARY =
  'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BTN_DESTRUCTIVE =
  'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

// Ghost: icon-only or minimal text. Add p-1.5 or p-2 at call site as needed.
export const BTN_GHOST =
  'inline-flex items-center gap-1.5 p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BTN_PRIMARY_SM =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BTN_SECONDARY_SM =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export const BTN_DESTRUCTIVE_SM =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const INPUT =
  'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-brand-500 disabled:opacity-50';

// Identical base to INPUT — kept separate so intent is explicit at the call site.
export const SELECT =
  'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500 disabled:opacity-50';

export const LABEL = 'block text-xs font-medium text-zinc-300 mb-1';

// ---------------------------------------------------------------------------
// Cards / panels
// ---------------------------------------------------------------------------

export const CARD = 'bg-zinc-900 border border-zinc-800 rounded-lg';

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

export const MODAL_OVERLAY =
  'fixed inset-0 z-50 flex items-center justify-center bg-black/60';

export const MODAL_BOX =
  'bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full flex flex-col overflow-hidden';
