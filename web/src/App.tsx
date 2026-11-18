import { useEffect } from "react";
import { parseRoute, usePathname, navigate } from "./lib/router";
import { useUI } from "./store/ui";
import { ProjectList } from "./pages/ProjectList";
import { EditorPage } from "./pages/EditorPage";
import { Overlays } from "./components/Overlays";

export function App() {
  const route = parseRoute(usePathname());
  const theme = useUI((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <>
      {route.name === "home" && <ProjectList />}
      {route.name === "project" && <EditorPage key={route.id} projectId={route.id} />}
      {route.name === "notFound" && (
        <div className="empty-state">
          <p>Página não encontrada.</p>
          <button className="btn" onClick={() => navigate("/")}>
            Voltar aos projetos
          </button>
        </div>
      )}
      <Overlays />
    </>
  );
}
