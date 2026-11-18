import { Icon } from "./Icon";
import { MenuButton } from "./Overlays";
import { usePrefs } from "../store/prefs";
import { useUI } from "../store/ui";

const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

export function PrefsMenu() {
  const prefs = usePrefs();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const Check = ({ on }: { on: boolean }) => (on ? <Icon name="check" /> : <span className="icon" />);
  return (
    <MenuButton label="Preferências" className="icon-btn" title="Preferências" button={<Icon name="settings" />} align="right">
      {() => (
        <div className="prefs-menu">
          <div className="menu-label">Editor</div>
          <label className="menu-row">
            <span>Tamanho da fonte</span>
            <select
              className="input input-sm"
              aria-label="Tamanho da fonte"
              value={prefs.fontSize}
              onChange={(e) => prefs.set({ fontSize: Number(e.target.value) })}
            >
              {FONT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}px
                </option>
              ))}
            </select>
          </label>
          <button className="menu-item" onClick={() => prefs.set({ lineWrap: !prefs.lineWrap })}>
            <Check on={prefs.lineWrap} /> Quebra de linha
          </button>
          <button className="menu-item" onClick={() => prefs.set({ keymap: prefs.keymap === "vim" ? "default" : "vim" })}>
            <Check on={prefs.keymap === "vim"} /> Modo Vim
          </button>
          <div className="menu-sep" />
          <div className="menu-label">Tema</div>
          <button className="menu-item" onClick={() => setTheme("light")}>
            <Check on={theme === "light"} /> Claro
          </button>
          <button className="menu-item" onClick={() => setTheme("dark")}>
            <Check on={theme === "dark"} /> Escuro
          </button>
        </div>
      )}
    </MenuButton>
  );
}
