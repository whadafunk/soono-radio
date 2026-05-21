import { HelpCircle } from 'lucide-react';
import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import React from 'react';

// Tooltip where the trigger is the children element (e.g. a badge).
// Renders the bubble via portal so it escapes overflow-hidden containers.
export function BadgeTooltip({ children, text, className }: {
  children: React.ReactNode;
  text: React.ReactNode;
  className?: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const handleEnter = () => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const above = r.top > 160;
    setPos({ x: r.left, y: above ? r.top : r.bottom, above });
  };

  return (
    <span className={`inline-block${className ? ` ${className}` : ''}`}>
      <span ref={ref} onMouseEnter={handleEnter} onMouseLeave={() => setPos(null)} className="cursor-default">
        {children}
      </span>
      {pos && createPortal(
        <span
          className="fixed w-52 bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-xs text-zinc-200 shadow-xl z-[9999] pointer-events-none whitespace-normal leading-relaxed"
          style={pos.above
            ? { left: pos.x, bottom: window.innerHeight - pos.y + 6 }
            : { left: pos.x, top: pos.y + 6 }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

interface HelpTooltipProps {
  text: React.ReactNode;
}

export function HelpTooltip({ text }: HelpTooltipProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [openAbove, setOpenAbove] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleShow = () => {
    if (buttonRef.current) {
      const { top } = buttonRef.current.getBoundingClientRect();
      setOpenAbove(top > 160);
    }
    setShowTooltip(true);
  };

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onMouseEnter={handleShow}
        onMouseLeave={() => setShowTooltip(false)}
        onClick={() => setShowTooltip(!showTooltip)}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 text-zinc-400 hover:text-indigo-400 transition-colors"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      {showTooltip && (
        <div
          className={`absolute left-0 w-48 bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-xs text-zinc-200 shadow-lg z-10 pointer-events-none ${
            openAbove ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          {text}
        </div>
      )}
    </div>
  );
}
