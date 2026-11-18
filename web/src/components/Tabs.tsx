import { useEditor } from "../store/editor";
import { basename } from "../lib/format";
import { Icon, fileIconName } from "./Icon";

export function Tabs() {
  const tabs = useEditor((s) => s.tabs);
  const active = useEditor((s) => s.active);
  const status = useEditor((s) => s.saveStatus);
  const setActive = useEditor((s) => s.setActive);
  const close = useEditor((s) => s.close);
  if (tabs.length === 0) return null;
  // Disambiguate equal basenames by showing the parent folder.
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(basename(t), (counts.get(basename(t)) ?? 0) + 1);
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => {
        const name = basename(t);
        const label = (counts.get(name) ?? 0) > 1 ? t.split("/").slice(-2).join("/") : name;
        const dirty = status[t] === "dirty" || status[t] === "saving";
        return (
          <div
            key={t}
            role="tab"
            aria-selected={t === active}
            className={`tab ${t === active ? "active" : ""}`}
            title={t}
            onClick={() => setActive(t)}
            onAuxClick={(e) => e.button === 1 && close(t)}
          >
            <Icon name={fileIconName(t)} />
            <span className="name">{label}</span>
            <button
              className="close"
              aria-label={`Fechar ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                close(t);
              }}
            >
              {dirty ? <span className="dirty" /> : <Icon name="x" style={{ width: 13, height: 13 }} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
