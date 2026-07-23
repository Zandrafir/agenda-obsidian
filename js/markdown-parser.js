/**
 * Parser de tarefas no padrão Obsidian.
 * Suporta:
 *   - [ ] Fazer algo #tag 📅 2026-07-25
 *   - [x] Já feito #outra-tag
 *   - [ ] Tarefa com due:: 2026-07-25 (estilo Dataview)
 */

const CHECKBOX_RE = /^(\s*)-\s*\[( |x|X)\]\s*(.+)$/;
const TAG_RE = /#([\p{L}\p{N}_\-\/]+)/gu;
const DATE_EMOJI_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const DATE_DATAVIEW_RE = /due::\s*(\d{4}-\d{2}-\d{2})/;
const DATE_PLAIN_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** Extrai metadados (tags, data) de uma linha de texto de tarefa, e devolve o texto "limpo". */
function extractMeta(rawText) {
  const tags = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(rawText)) !== null) tags.push(m[1]);

  const dateMatch =
    rawText.match(DATE_EMOJI_RE) ||
    rawText.match(DATE_DATAVIEW_RE) ||
    rawText.match(DATE_PLAIN_RE);
  const dueDate = dateMatch ? dateMatch[1] : null;

  const cleanText = rawText
    .replace(DATE_EMOJI_RE, '')
    .replace(DATE_DATAVIEW_RE, '')
    .replace(TAG_RE, '')
    .trim();

  return { tags, dueDate, cleanText };
}

/**
 * Recebe o conteúdo de um arquivo .md e o caminho relativo (dentro do vault).
 * Retorna um array de tarefas: { sourceFile, lineNumber, rawLine, title, done, tags, dueDate }
 */
function parseMarkdownTasks(content, sourceFile) {
  const lines = content.split(/\r?\n/);
  const tasks = [];

  lines.forEach((line, idx) => {
    const match = line.match(CHECKBOX_RE);
    if (!match) return;

    const done = match[2].toLowerCase() === 'x';
    const { tags, dueDate, cleanText } = extractMeta(match[3]);

    tasks.push({
      sourceFile,
      lineNumber: idx + 1,
      rawLine: line,
      title: cleanText,
      done,
      tags,
      dueDate,
    });
  });

  return tasks;
}

/**
 * Reescreve uma linha específica do arquivo alternando o estado do checkbox.
 * Usado para refletir "concluído no app" de volta pro .md.
 */
function toggleCheckboxInContent(content, lineNumber, done) {
  const lines = content.split(/\r?\n/);
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return content;

  const newMark = done ? 'x' : ' ';
  lines[idx] = lines[idx].replace(CHECKBOX_RE, (full, indent, _mark, rest) => `${indent}- [${newMark}] ${rest}`);
  return lines.join('\n');
}

export { parseMarkdownTasks, toggleCheckboxInContent, extractMeta };
