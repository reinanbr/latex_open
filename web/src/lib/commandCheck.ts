/**
 * Live check of the commands and environments used in a LaTeX source against
 * what the class, the loaded packages and the project itself define — the
 * "Undefined control sequence" / "Environment undefined" errors, found while
 * typing, with a fix: load the package that defines it, or the name that was
 * probably meant.
 */
import { closest, ENGINE_PREFIX, type LatexKB, type Scope } from "./latexKB";
import type { LatexUse } from "./syntaxCheck";

export type CommandFix = { kind: "replace"; from: number; to: number; text: string } | { kind: "package"; name: string };

export interface CommandWarning {
  from: number;
  to: number;
  message: string;
  fixes: { label: string; fix: CommandFix }[];
}

export interface CommandContext {
  kb: LatexKB;
  scope: Scope;
  /** Commands and environments the project defines (index + live text). */
  commands: Set<string>;
  envs: Set<string>;
  /** Names preferred among typo suggestions (the common ones). */
  preferred?: Set<string>;
  /** Classes in use, for messages. */
  classes: string[];
  /** Cursor offset: the word being typed is not checked yet. */
  cursor?: number;
}

const MAX = 200;

function knownCommand(name: string, cx: CommandContext) {
  const s = cx.scope;
  return (
    s.cmds.has(name) ||
    s.hidden.has(name) ||
    cx.commands.has(name) ||
    ENGINE_PREFIX.test(name) ||
    // \center … \endcenter: environments are commands too.
    s.envs.has(name) ||
    cx.envs.has(name) ||
    (name.startsWith("end") && (s.envs.has(name.slice(3)) || cx.envs.has(name.slice(3))))
  );
}

function knownEnv(name: string, cx: CommandContext) {
  const s = cx.scope;
  // \begin{x} only needs the command \x.
  return s.envs.has(name) || cx.envs.has(name) || s.cmds.has(name) || cx.commands.has(name) || s.hidden.has(name);
}

export function checkCommands(uses: LatexUse[], cx: CommandContext): CommandWarning[] {
  const out: CommandWarning[] = [];
  const classText = cx.classes.length ? `na classe ${cx.classes.join(", ")}` : "na classe do documento";
  for (const u of uses) {
    if (out.length >= MAX) break;
    if (cx.cursor !== undefined && cx.cursor >= u.from && cx.cursor <= u.to) continue;
    const isCmd = u.kind === "command";
    if (isCmd ? knownCommand(u.name, cx) : knownEnv(u.name, cx)) continue;

    const shown = isCmd ? `\\${u.name}` : `{${u.name}}`;
    const what = isCmd ? "O comando" : "O ambiente";
    const provider = cx.kb.provider(u.name, isCmd ? "command" : "env");
    if (provider && "package" in provider) {
      out.push({
        from: u.from,
        to: u.to,
        message: `${what} ${shown} é do pacote ${provider.package}, que não está carregado.`,
        fixes: [{ label: `Adicionar \\usepackage{${provider.package}}`, fix: { kind: "package", name: provider.package } }],
      });
      continue;
    }
    const pool = isCmd ? [...cx.scope.cmds.keys(), ...cx.commands] : [...cx.scope.envs.keys(), ...cx.envs];
    const guesses = closest(u.name, pool, cx.preferred);
    const fixes = guesses.map((g) => ({
      label: isCmd ? `Trocar por \\${g}` : `Trocar por {${g}}`,
      fix: { kind: "replace" as const, from: isCmd ? u.from + 1 : u.from, to: u.to, text: g },
    }));
    let message: string;
    if (provider && "classes" in provider) {
      const list = provider.classes.slice(0, 4).join(", ") + (provider.classes.length > 4 ? "…" : "");
      message = `${what} ${shown} não existe ${classText}; ele é definido pelas classes ${list}.`;
    } else {
      message = isCmd
        ? `Comando desconhecido: ${shown} não é definido pela classe, pelos pacotes carregados nem pelo projeto.`
        : `Ambiente desconhecido: ${shown} não é definido pela classe, pelos pacotes carregados nem pelo projeto.`;
    }
    if (guesses.length) message += ` Você quis dizer ${isCmd ? "\\" + guesses[0] : "{" + guesses[0] + "}"}?`;
    out.push({ from: u.from, to: u.to, message, fixes });
  }
  return out;
}
