import { HelpCircle } from 'lucide-react';
import { useState } from 'react';

interface HelpTooltipProps {
  text: string;
}

export function HelpTooltip({ text }: HelpTooltipProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onClick={() => setShowTooltip(!showTooltip)}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 text-zinc-400 hover:text-indigo-400 transition-colors"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      {showTooltip && (
        <div className="absolute left-0 bottom-full mb-2 w-48 bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-xs text-zinc-200 shadow-lg z-10 pointer-events-none">
          {text}
        </div>
      )}
    </div>
  );
}
