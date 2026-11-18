import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ProjectMeta, WordCount as WC } from "../api/types";
import { estimateWords, inputsOf } from "../lib/wordcount";
import { useCompile } from "../store/compile";
import { MenuButton } from "./Overlays";

/** Approximate count in the browser, following \input/\include. */
async function estimate(projectId: string, mainFile: string): Promise<WC> {
  const seen = new Set<string>();
  let words = 0;
  const visit = async (path: string, depth: number) => {
    if (seen.has(path) || depth > 8 || seen.size > 200) return;
    seen.add(path);
    let text: string;
    try {
      text = await api.readText(projectId, path);
    } catch {
      return; // missing include: LaTeX would complain, the count just skips it
    }
    words += estimateWords(text);
    for (const f of inputsOf(text)) await visit(f, depth + 1);
  };
  await visit(mainFile, 0);
  return { words, headers: 0, captions: 0, math: 0, source: "estimate" };
}

const fmt = new Intl.NumberFormat("pt-BR");

/** Word count in the top bar; refreshed after each compilation. */
export function WordCount({ meta }: { meta: ProjectMeta }) {
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities, staleTime: Infinity });
  const buildId = useCompile((s) => s.result?.buildId ?? null);
  const texcount = caps.data?.texcount.available ?? false;
  const q = useQuery({
    queryKey: ["wordcount", meta.id, meta.mainFile, buildId, texcount],
    enabled: !!meta.mainFile && caps.isSuccess,
    queryFn: async () => {
      if (texcount) {
        try {
          return await api.wordCount(meta.id);
        } catch {
          /* fall back to the estimate */
        }
      }
      return estimate(meta.id, meta.mainFile);
    },
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });
  if (!meta.mainFile || !q.data) return null;
  const wc = q.data;
  const approx = wc.source === "estimate";
  return (
    <MenuButton
      label="Contagem de palavras"
      className="btn btn-ghost btn-sm wordcount"
      title={approx ? "Estimativa (texcount não está instalado)" : "Contagem do texcount"}
      button={
        <>
          {approx ? "≈ " : ""}
          {fmt.format(wc.words)} palavras
        </>
      }
      align="right"
    >
      {() => (
        <div className="wordcount-details">
          <div className="menu-label">Contagem de palavras</div>
          <dl>
            <dt>Texto</dt>
            <dd>{fmt.format(wc.words)}</dd>
            {!approx && (
              <>
                <dt>Títulos</dt>
                <dd>{fmt.format(wc.headers)}</dd>
                <dt>Legendas etc.</dt>
                <dd>{fmt.format(wc.captions)}</dd>
                <dt>Fórmulas</dt>
                <dd>{fmt.format(wc.math)}</dd>
              </>
            )}
          </dl>
          <div className="menu-note">
            {approx
              ? "Estimativa feita no navegador: o texcount não está instalado no servidor."
              : `Contado pelo texcount a partir de ${meta.mainFile}, seguindo \\input e \\include.`}
          </div>
        </div>
      )}
    </MenuButton>
  );
}
