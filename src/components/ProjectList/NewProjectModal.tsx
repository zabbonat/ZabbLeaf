import React, { useEffect, useState } from 'react';
import { X, FilePlus2 } from 'lucide-react';
import { PROJECT_TEMPLATES, ProjectTemplate } from '../../services/projectTemplates';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, template: ProjectTemplate) => void;
}

/**
 * Replaces the browser prompt() that used to ask for a name.
 *
 * A new project started as an empty main.tex, which is the point at which most
 * people go and copy a preamble from an old paper. Every template here uses
 * only classes and packages a plain TeX installation already has, so the first
 * compile works rather than opening with a missing-class error.
 */
export const NewProjectModal: React.FC<NewProjectModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string>(PROJECT_TEMPLATES[0].id);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setChosen(PROJECT_TEMPLATES[0].id);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const template = PROJECT_TEMPLATES.find(entry => entry.id === chosen) || PROJECT_TEMPLATES[0];

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, template);
  };

  return (
    <div className="modal-overlay">
      <form className="modal-content new-project-modal" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <FilePlus2 size={22} color="#6fa8cc" />
            <h2 className="modal-title">New project</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#a0a9b5', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        <div className="input-group">
          <label className="input-label" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            className="input-control"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Thesis, Paper on X, Talk for Y..."
            autoFocus
          />
        </div>

        <div className="input-label" style={{ marginBottom: '8px' }}>
          Start from
        </div>
        <div className="template-grid">
          {PROJECT_TEMPLATES.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={`template-card ${entry.id === chosen ? 'active' : ''}`}
              onClick={() => setChosen(entry.id)}
            >
              <span className="template-emoji">{entry.emoji}</span>
              <span className="template-name">{entry.name}</span>
              <span className="template-description">{entry.description}</span>
              <span className="template-files">
                {entry.files.length} file{entry.files.length === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>

        <p className="template-note">
          The project is created on your computer. To put it on Overleaf, make an empty project
          there and press Sync — ZabbLeaf links the two.
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }}>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-sync" disabled={!name.trim()}>
            Create {template.name.toLowerCase()}
          </button>
        </div>
      </form>
    </div>
  );
};
