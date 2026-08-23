import React from 'react';
import { AlertTriangle, AlertCircle, Info, Download, Loader2 } from 'lucide-react';
import { Diagnostic } from '../../services/latexErrors';

interface CompileProblemsProps {
  diagnostics: Diagnostic[];
  onJump: (fileName: string | undefined, line: number | undefined) => void;
  onInstallPackage: (packageName: string) => void;
  installing: string;
}

const ICONS = {
  error: <AlertCircle size={13} color="#c97b7b" />,
  warning: <AlertTriangle size={13} color="#d1a054" />,
  info: <Info size={13} color="#89a7bd" />
};

/**
 * The compiler log, read for the user.
 *
 * `! Undefined control sequence.` is where most people stop: it names no
 * command, no cause and no fix. Each entry here says what went wrong, why, and
 * what to do — and when the answer is a missing package, the button installs it
 * rather than sending anyone to a forum thread from 2009.
 */
export const CompileProblems: React.FC<CompileProblemsProps> = ({
  diagnostics,
  onJump,
  onInstallPackage,
  installing
}) => {
  if (diagnostics.length === 0) return null;

  return (
    <div className="compile-problems">
      {diagnostics.map(diagnostic => (
        <div key={diagnostic.id} className={`problem ${diagnostic.severity}`}>
          <div className="problem-head">
            {ICONS[diagnostic.severity]}
            <span className="problem-title">{diagnostic.title}</span>
            {diagnostic.line && (
              <button
                className="problem-where"
                onClick={() => onJump(diagnostic.fileName, diagnostic.line)}
                title="Go to this line"
              >
                {diagnostic.fileName ? `${diagnostic.fileName}:` : 'line '}
                {diagnostic.line}
              </button>
            )}
          </div>

          <p className="problem-explanation">{diagnostic.explanation}</p>
          <p className="problem-fix">{diagnostic.fix}</p>

          {diagnostic.missingPackage && (
            <button
              className="problem-install"
              disabled={!!installing}
              onClick={() => onInstallPackage(diagnostic.missingPackage as string)}
            >
              {installing === diagnostic.missingPackage ? (
                <>
                  <Loader2 size={12} className="spin" /> Installing {diagnostic.missingPackage}...
                </>
              ) : (
                <>
                  <Download size={12} /> Install {diagnostic.missingPackage}
                </>
              )}
            </button>
          )}

          <details className="problem-raw">
            <summary>What the engine printed</summary>
            <code>{diagnostic.raw}</code>
          </details>
        </div>
      ))}
    </div>
  );
};
