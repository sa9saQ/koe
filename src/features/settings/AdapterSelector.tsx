// Recorder adapter selector. M1 only supports "sqlite"; future adapters are
// shown as disabled to preview the UI without allowing invalid selection.

interface AdapterSelectorProps {
  value: string;
  onChange?: (name: string) => void;
  disabled?: boolean;
}

const ADAPTERS = [
  { name: "sqlite", label: "ローカル (SQLite)", available: true },
  { name: "obsidian", label: "Obsidian (M2)", available: false },
  { name: "notion", label: "Notion (M3)", available: false },
];

export function AdapterSelector({ value, onChange, disabled = false }: AdapterSelectorProps) {
  return (
    <div className="koe-adapter-selector">
      <label htmlFor="koe-adapter-select" className="koe-label">
        保存先アダプター
      </label>
      <select
        id="koe-adapter-select"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        className="koe-select"
      >
        {ADAPTERS.map((a) => (
          <option key={a.name} value={a.name} disabled={!a.available}>
            {a.label}
          </option>
        ))}
      </select>
    </div>
  );
}
