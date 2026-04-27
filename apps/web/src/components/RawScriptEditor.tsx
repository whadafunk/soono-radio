import { useState, useEffect } from 'react';
import { Loader, X, Check, AlertCircle } from 'lucide-react';

interface RawScriptEditorProps {
  isOpen: boolean;
  title: string;
  language?: string;
  fetchScript: () => Promise<string>;
  saveScript: (content: string) => Promise<void>;
  onClose: () => void;
  hint?: string;
}

export function RawScriptEditor({
  isOpen,
  title,
  fetchScript,
  saveScript,
  onClose,
  hint,
}: RawScriptEditorProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const text = await fetchScript();
        if (!cancelled) {
          setContent(text);
          setError('');
          setSuccess(false);
        }
      } catch (err) {
        if (!cancelled) setError(`Failed to load: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, fetchScript]);

  const handleSave = async () => {
    try {
      setLoading(true);
      setError('');
      setSuccess(false);
      await saveScript(content);
      setSuccess(true);
      setTimeout(() => {
        onClose();
        setSuccess(false);
      }, 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-[95vw] h-[95vh] max-w-7xl flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-xl font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col p-6 min-h-0">
          {error && (
            <div className="mb-4 bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-300 flex items-start gap-2 flex-shrink-0">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {success && (
            <div className="mb-4 bg-green-900/20 border border-green-800 rounded-lg p-3 text-green-300 flex items-start gap-2 flex-shrink-0">
              <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p className="text-sm">Saved successfully!</p>
            </div>
          )}

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-white font-mono text-sm resize focus:outline-none focus:border-indigo-500 overflow-auto min-h-0"
            disabled={loading}
            spellCheck="false"
          />

          <p className="text-xs text-zinc-500 mt-3 flex-shrink-0">
            {hint ?? 'Edit carefully. Invalid input will be rejected. Drag the bottom-right corner to resize.'}
          </p>
        </div>

        <div className="flex gap-3 p-6 border-t border-zinc-800 flex-shrink-0">
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <Loader className="w-4 h-4 animate-spin" />}
            Save & Apply
          </button>
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
