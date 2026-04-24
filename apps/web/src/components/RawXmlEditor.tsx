import { useState, useEffect } from 'react';
import { Loader, X, Check, AlertCircle } from 'lucide-react';

interface RawXmlEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (xml: string) => Promise<void>;
}

export function RawXmlEditor({ isOpen, onClose, onSave }: RawXmlEditorProps) {
  const [xml, setXml] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchXml();
    }
  }, [isOpen]);

  const fetchXml = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/icecast/config/raw');
      const data = await res.json();

      // Pretty-print the XML
      const parser = new DOMParser();
      const doc = parser.parseFromString(data.xml, 'text/xml');

      if (doc.documentElement.tagName === 'parsererror') {
        setXml(data.xml);
      } else {
        // Simple pretty-printing: add newlines and indentation
        const serialized = new XMLSerializer().serializeToString(doc);
        setXml(formatXml(serialized));
      }
      setError('');
      setSuccess(false);
    } catch (err) {
      setError(`Failed to load XML: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const formatXml = (xml: string): string => {
    let formatted = '';
    let indent = 0;
    const lines = xml.split(/(?<=>)/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('</')) {
        indent--;
      }

      formatted += '  '.repeat(Math.max(0, indent)) + trimmed + '\n';

      if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>')) {
        if (!trimmed.includes('</')) {
          indent++;
        }
      }
    }

    return formatted;
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      setError('');
      setSuccess(false);

      await onSave(xml);

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
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800">
          <h2 className="text-xl font-semibold text-white">Edit Raw XML</h2>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col p-6">
          {error && (
            <div className="mb-4 bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {success && (
            <div className="mb-4 bg-green-900/20 border border-green-800 rounded-lg p-3 text-green-300 flex items-start gap-2">
              <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p className="text-sm">XML saved successfully!</p>
            </div>
          )}

          <textarea
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-white font-mono text-xs resize-none focus:outline-none focus:border-indigo-500"
            disabled={loading}
          />

          <p className="text-xs text-zinc-500 mt-2">
            Edit the raw XML carefully. Invalid XML will be rejected.
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-zinc-800">
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
