/**
 * Short explanations for the most common TeX/LaTeX/BibTeX messages, shown
 * under the message in the editor pop-ups and in the problem list.
 */
const HINTS: [RegExp, string][] = [
  [/Undefined control sequence/, "Um comando não foi reconhecido. Confira a grafia (maiúsculas contam) ou carregue com \\usepackage o pacote que o define."],
  [/Missing \$ inserted/, "Algo que só vale em fórmulas (como ^, _ ou \\alpha) apareceu fora de $…$, ou uma fórmula ficou aberta. Para os símbolos literais, use \\^{}, \\_ ou \\$."],
  [/Display math should end with \$\$/, "Uma fórmula aberta com $$ foi fechada com um único $ (ou o contrário)."],
  [/Extra \}, or forgotten \$/, "Há uma chave } sobrando ou uma fórmula sem o $ de fechamento perto desta linha."],
  [/Missing \} inserted/, "Faltou fechar uma chave {…}, muitas vezes dentro de uma fórmula."],
  [/Too many \}'s/, "Há uma chave } a mais, sem a { correspondente."],
  [/Missing \{ inserted/, "Falta uma chave { — por exemplo, num expoente com vários caracteres: escreva x^{10}, não x^10."],
  [/Misplaced alignment tab character &/, "O caractere & só funciona em tabelas e alinhamentos. Para o símbolo &, escreva \\&."],
  [/Extra alignment tab has been changed to \\cr/, "Uma linha da tabela tem mais colunas (&) do que o declarado em \\begin{tabular}{…}."],
  [/Environment .* undefined/, "Este ambiente não existe: confira a grafia ou carregue o pacote que o define."],
  [/\\begin\{.*\} on input line .* ended by \\end\{/, "Os ambientes foram fechados fora de ordem: cada \\begin{x} precisa de um \\end{x}, do mais interno para o mais externo."],
  [/\\begin\{.*\} ended by \\end\{document\}/, "Um ambiente ficou aberto até o fim do documento: falta o \\end correspondente."],
  [/There's no line here to end/, "\\\\ ou \\newline foi usado onde não há linha para quebrar (logo após uma linha em branco ou no início de um ambiente). Use uma linha em branco para mudar de parágrafo."],
  [/Paragraph ended before .* was complete/, "Um argumento entre chaves não foi fechado antes de uma linha em branco."],
  [/Runaway argument/, "Um argumento começou com { e não foi fechado: falta uma chave }."],
  [/Missing \\begin\{document\}/, "Há texto antes de \\begin{document}, ou um erro no preâmbulo fez o LaTeX começar a compor cedo demais."],
  [/Double (superscript|subscript)/, "Dois ^ (ou dois _) seguidos no mesmo termo. Agrupe com chaves: x^{a^b} ou {x^a}^b."],
  [/Citation .* undefined/, "Esta chave de citação não existe nos arquivos .bib do projeto (ou o .bib não foi carregado). Se acabou de adicioná-la, recompile."],
  [/Reference .* undefined/, "Não existe \\label com este nome. Se acabou de criá-lo, recompile: referências precisam de duas passagens."],
  [/Label .* multiply defined/, "O mesmo nome de \\label foi usado mais de uma vez; as referências podem apontar para o lugar errado."],
  [/There were undefined references/, "Algumas referências ou citações não foram resolvidas; veja os avisos acima."],
  [/Invalid UTF-8/, "O arquivo tem um caractere que o LaTeX não reconhece. Em blocos lstlisting, acrescente-o à opção literate do \\lstset; fora deles, verifique se o arquivo está em UTF-8."],
  [/Unicode character .* not set up for use with LaTeX/, "Este caractere não existe nas fontes em uso. Troque-o por um comando LaTeX, ou compile com XeLaTeX/LuaLaTeX."],
  [/File `.*' not found/, "O arquivo não foi encontrado. Confira o nome e o caminho (maiúsculas contam) e se ele está no projeto."],
  [/Too many unprocessed floats/, "Há figuras ou tabelas demais esperando lugar. Use \\clearpage de vez em quando ou mude o posicionamento ([htbp])."],
  [/Float\(s\) lost/, "Uma figura ou tabela foi colocada onde não pode, como dentro de uma nota de rodapé ou de uma minipage."],
  [/Font shape .* undefined/, "Esta variação de fonte (negrito, itálico, versalete…) não existe na fonte escolhida e foi substituída."],
  [/Overfull \\hbox/, "O texto passou da margem direita, geralmente por uma palavra sem hifenização, uma URL ou uma figura larga."],
  [/Underfull \\hbox/, "A linha ficou com espaços largos demais. Normalmente pode ser ignorado."],
  [/Overfull \\vbox/, "O conteúdo passou do fim da página (uma figura ou tabela alta demais, por exemplo)."],
  [/Underfull \\vbox/, "A página ficou com espaço vertical sobrando. Normalmente pode ser ignorado."],
  [/I couldn't open (database|style) file/, "O BibTeX não achou o arquivo .bib ou .bst. Confira o nome em \\bibliography{…} / \\bibliographystyle{…}."],
  [/I didn't find a database entry for/, "Esta chave de citação não existe no .bib."],
  [/empty (year|journal|title|author|publisher|school|booktitle) in/, "Falta este campo na entrada do .bib; a referência sairá incompleta."],
  [/Repeated entry/, "Duas entradas do .bib têm a mesma chave."],
  [/Emergency stop|Fatal error occurred/, "O TeX parou por causa de um erro anterior; corrija o primeiro erro da lista."],
  [/excedeu o tempo limite/, "Compilações longas podem precisar de mais tempo (opção --compile-timeout do servidor) ou do modo rascunho."],
];

export function hintFor(message: string): string | null {
  for (const [re, hint] of HINTS) if (re.test(message)) return hint;
  return null;
}
