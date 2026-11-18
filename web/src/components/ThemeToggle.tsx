import { useUI } from "../store/ui";
import { Icon } from "./Icon";

export function ThemeToggle() {
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const next = theme === "dark" ? "light" : "dark";
  const label = theme === "dark" ? "Usar tema claro" : "Usar tema escuro";
  return (
    <button className="icon-btn" title={label} aria-label={label} onClick={() => setTheme(next)}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
