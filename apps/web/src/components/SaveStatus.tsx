const STYLES = {
  success: 'bg-green-900/20 border border-green-800 text-green-300',
  error:   'bg-red-900/20 border border-red-800 text-red-300',
  warning: 'bg-amber-900/20 border border-amber-800 text-amber-300',
};

interface Props {
  status: { type: keyof typeof STYLES; message: string } | null;
}

export function SaveStatus({ status }: Props) {
  if (!status) return null;
  return (
    <div className={`w-full px-3 py-1.5 rounded-lg text-sm ${STYLES[status.type]}`}>
      {status.message}
    </div>
  );
}
