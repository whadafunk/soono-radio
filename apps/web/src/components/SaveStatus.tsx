const STYLES = {
  success: 'bg-green-900/20 border border-green-800 text-green-300',
  error:   'bg-red-900/20 border border-red-800 text-red-300',
  warning: 'bg-amber-900/20 border border-amber-800 text-amber-300',
};

interface Props {
  status: { type: keyof typeof STYLES; message: string } | null;
  onDismiss?: () => void;
}

export function SaveStatus({ status, onDismiss }: Props) {
  if (!status) return null;
  return (
    <div className={`w-full px-3 py-1.5 rounded-lg text-sm flex items-start gap-2 ${STYLES[status.type]}`}>
      <span className="flex-1 break-all">{status.message}</span>
      {status.type === 'error' && onDismiss && (
        <button onClick={onDismiss} className="flex-shrink-0 text-xs opacity-60 hover:opacity-100 ml-1">✕</button>
      )}
    </div>
  );
}
