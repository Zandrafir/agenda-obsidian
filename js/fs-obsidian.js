/**
 * Integração com o vault do Obsidian via File System Access API.
 * Funciona em Chrome/Edge. O handle da pasta é guardado no IndexedDB
 * (via idb-keyval simplificado abaixo) para não precisar reautorizar toda vez.
 */

import { parseMarkdownTasks, toggleCheckboxInContent } from './markdown-parser.js';

const DB_NAME = 'agenda-obsidian';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'vaultDirHandle';

function openHandleStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openHandleStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openHandleStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Pede ao usuário para escolher a pasta do vault (uma vez) e guarda o handle. */
async function chooseVaultFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

/** Recupera o handle salvo, revalidando a permissão. Retorna null se nunca foi escolhido. */
async function getSavedVaultFolder() {
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) return null;

  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return handle;

  const req = await handle.requestPermission({ mode: 'readwrite' });
  return req === 'granted' ? handle : null;
}

/** Percorre recursivamente o diretório coletando arquivos .md com seu caminho relativo. */
async function* walkMarkdownFiles(dirHandle, prefix = '') {
  for await (const [name, handle] of dirHandle.entries()) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (name.startsWith('.')) continue; // pula .obsidian, .trash etc
      yield* walkMarkdownFiles(handle, relPath);
    } else if (name.endsWith('.md')) {
      yield { relPath, fileHandle: handle };
    }
  }
}

/** Lê todo o vault e retorna a lista de tarefas encontradas em todos os arquivos .md. */
async function scanVaultTasks(dirHandle) {
  const allTasks = [];
  for await (const { relPath, fileHandle } of walkMarkdownFiles(dirHandle)) {
    const file = await fileHandle.getFile();
    const content = await file.text();
    allTasks.push(...parseMarkdownTasks(content, relPath));
  }
  return allTasks;
}

/** Navega até o arquivo pelo caminho relativo (ex: "Diario/2026-07-23.md") a partir do handle raiz. */
async function resolveFileHandle(rootHandle, relPath) {
  const parts = relPath.split('/');
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return dir.getFileHandle(parts[parts.length - 1]);
}

/** Marca/desmarca o checkbox de uma tarefa direto no arquivo original do vault. */
async function writeTaskDoneBackToFile(rootHandle, sourceFile, lineNumber, done) {
  const fileHandle = await resolveFileHandle(rootHandle, sourceFile);
  const file = await fileHandle.getFile();
  const content = await file.text();
  const updated = toggleCheckboxInContent(content, lineNumber, done);

  const writable = await fileHandle.createWritable();
  await writable.write(updated);
  await writable.close();
}

export {
  chooseVaultFolder,
  getSavedVaultFolder,
  scanVaultTasks,
  writeTaskDoneBackToFile,
};
