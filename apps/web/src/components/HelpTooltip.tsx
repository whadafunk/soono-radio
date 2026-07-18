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

const TOOLTIP_WIDTH = 192; // matches w-48
const VIEWPORT_MARGIN = 12;

// Renders the bubble via portal (like BadgeTooltip above) so it escapes the
// modal's overflow-y-auto scroll container — that container's overflow-x is
// implicitly forced to non-visible by the CSS spec, which was silently
// clipping any icon in a right-hand grid column. Also flips horizontally
// when there isn't room to the right, mirroring the existing vertical flip.
export function HelpTooltip({ text }: HelpTooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean; alignRight: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleShow = () => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const above = r.top > 160;
    const alignRight = window.innerWidth - r.left < TOOLTIP_WIDTH + VIEWPORT_MARGIN;
    setPos({ x: alignRight ? r.right : r.left, y: above ? r.top : r.bottom, above, alignRight });
  };

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onMouseEnter={handleShow}
        onMouseLeave={() => setPos(null)}
        onClick={() => (pos ? setPos(null) : handleShow())}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 text-zinc-400 hover:text-brand-400 transition-colors"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      {pos && createPortal(
        <div
          className="fixed w-48 bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-xs text-zinc-200 shadow-lg z-[9999] pointer-events-none"
          style={{
            ...(pos.alignRight ? { right: window.innerWidth - pos.x } : { left: pos.x }),
            ...(pos.above ? { bottom: window.innerHeight - pos.y + 6 } : { top: pos.y + 6 }),
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </div>
  );
}
