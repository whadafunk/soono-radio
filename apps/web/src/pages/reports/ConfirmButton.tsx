import { useState } from 'react';

// Two-step inline confirmation — never a browser pop-up.
export function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, disabled, icon }: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
        className="inline-flex items-center gap-1 px-2 py-1 text-sm text-zinc-400 hover:text-red-300 disabled:opacity-40"
        title={label}
      >
        {icon}{label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <button type="button" onClick={() => { setAsking(false); onConfirm(); }} className="px-2 py-1 rounded bg-red-900/60 text-red-200 hover:bg-red-800">
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="px-2 py-1 text-zinc-300 hover:text-white">
        Cancel
      </button>
    </span>
  );
}
