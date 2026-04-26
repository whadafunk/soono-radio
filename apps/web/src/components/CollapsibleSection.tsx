import { useState, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { HelpTooltip } from './HelpTooltip';

interface Props {
  title: string;
  helpText?: string;
  /** Extra content rendered on the right side of the header (e.g., an "Add" button). Only shown when the section is open. */
  headerExtra?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  helpText,
  headerExtra,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 gap-4">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-lg font-semibold text-white hover:text-zinc-200 transition-colors"
        >
          <ChevronDown
            className={`w-5 h-5 text-zinc-400 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          {title}
          {helpText && <HelpTooltip text={helpText} />}
        </button>
        {open && headerExtra}
      </div>
      {open && <div className="px-6 pb-6 pt-2 border-t border-zinc-800">{children}</div>}
    </section>
  );
}
