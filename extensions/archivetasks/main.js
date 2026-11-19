const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  archiveFolder: 'Private/Archive',
};

function captureScrollPositions(editor) {
  const saved = [];
  const seen = new Set();
  const addEl = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    if (el.scrollHeight > el.clientHeight || el.scrollTop > 0 || el.scrollLeft > 0) {
      saved.push({ el, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft });
    }
  };

  const view = editor?.view;
  if (view) {
    addEl(view.scrollDOM);
    if (view.dom) {
      if (typeof view.dom.querySelector === 'function') {
        addEl(view.dom.querySelector('.cm-scroller'));
      }
      let cur = view.dom;
      for (let depth = 0; cur && depth < 6; depth++) {
        addEl(cur);
        cur = cur.parentElement;
      }
    }
  }
  return saved;
}

function restoreScrollPositions(saved, editor) {
  if (!saved || saved.length === 0) return;
  const apply = () => {
    for (const { el, scrollTop, scrollLeft } of saved) {
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(scrollTop, maxTop);
      el.scrollLeft = scrollLeft;
    }
    if (editor && typeof editor.syncScrollbar === 'function') {
      editor.syncScrollbar();
    }
  };
  apply();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(apply);
  }
}

function buildDeletionChanges(doc, removedLineRanges) {
  if (!removedLineRanges.length) return [];

  const mergedLines = [];
  for (const range of removedLineRanges) {
    const prev = mergedLines[mergedLines.length - 1];
    if (prev && range.startLine <= prev.endLine + 1) {
      prev.endLine = Math.max(prev.endLine, range.endLine);
    } else {
      mergedLines.push({ startLine: range.startLine, endLine: range.endLine });
    }
  }

  const deletions = [];
  for (const { startLine, endLine } of mergedLines) {
    let from;
    let to;
    if (endLine + 1 < doc.lines) {
      from = doc.line(startLine + 1).from;
      to = doc.line(endLine + 2).from;
    } else if (startLine > 0) {
      from = doc.line(startLine).to;
      to = doc.line(endLine + 1).to;
    } else {
      from = 0;
      to = doc.length;
    }

    const prev = deletions[deletions.length - 1];
    if (prev && from <= prev.to) {
      prev.to = Math.max(prev.to, to);
    } else {
      deletions.push({ from, to, insert: '' });
    }
  }
  return deletions;
}

function mapPosThroughDeletions(pos, deletions) {
  let shift = 0;
  for (const del of deletions) {
    if (pos <= del.from) break;
    if (pos >= del.to) {
      shift += del.to - del.from;
    } else {
      return del.from - shift;
    }
  }
  return Math.max(0, pos - shift);
}

/** @param {import('../../mirage').AppContext} app */
module.exports = class ArchiveTasksExtension {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...saved };

    this.addSettingTab({
      name: 'ArchiveTasks',
      description: 'Configure where completed tasks are archived.',
      settings: [
        {
          key: 'archiveFolder',
          name: 'Archive Folder',
          description: 'Vault-relative folder path for monthly archive notes.',
          type: 'text',
          placeholder: DEFAULT_SETTINGS.archiveFolder,
          default: DEFAULT_SETTINGS.archiveFolder,
        },
      ],
    });

    this.addCommand({
      id: 'archive-tasks',
      name: 'Archive Completed Tasks',
      callback: () => this.archiveCompletedTasks(),
    });
  }

  onunload() {}

  async onSettingChange(key, value) {
    this.settings[key] = value;
    await this.saveData(this.settings);
  }

  async archiveCompletedTasks() {
    const { vault, workspace, cache, events, vaporNote } = this.app;

    if (!vault.isOpen()) {
      this.app.notify({
        title: 'Archive Tasks',
        body: 'No vault is currently open.',
        type: 'warning',
      });
      return;
    }

    let isVaporFocused = false;
    try {
      if (vaporNote && typeof vaporNote.isFocused === 'function') {
        isVaporFocused = await vaporNote.isFocused();
      }
    } catch (_) {}

    if (isVaporFocused) {
      this.app.notify({
        title: 'Archive Tasks',
        body: 'Focus a Markdown tab in the main workspace to archive tasks (VaporNote tab state is not exposed by the SDK).',
        type: 'warning',
      });
      return;
    }

    const mainTab = workspace.activeLeaf?.activeTab;
    const activeFilePath = mainTab?.type === 'markdown' ? mainTab.filePath : null;
    const activeEditor = mainTab?.editor || null;
    const activeTabId = mainTab?.id || null;

    if (!activeFilePath || !vault.exists(activeFilePath)) {
      this.app.notify({
        title: 'Archive Tasks',
        body: 'No active Markdown note found to archive from.',
        type: 'warning',
      });
      return;
    }

    // Flush any pending unsaved keystrokes first
    if (activeEditor && typeof activeEditor.flush === 'function') {
      activeEditor.flush();
    }

    const rawFolder = (this.settings.archiveFolder || DEFAULT_SETTINGS.archiveFolder)
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const archiveFolder = rawFolder || DEFAULT_SETTINGS.archiveFolder;

    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const archiveFileName = `(Archive) ${year}-${month}.md`;
    const archivePath = `${archiveFolder}/${archiveFileName}`;

    if (activeFilePath === archivePath) {
      this.app.notify({
        title: 'Archive Tasks',
        body: 'Cannot archive tasks from the active monthly archive note itself.',
        type: 'info',
      });
      return;
    }

    const sourceTitle = path.basename(activeFilePath, '.md');
    const savedScroll = captureScrollPositions(activeEditor);
    const doc = activeEditor?.view?.state?.doc || null;
    const lines = doc
      ? Array.from({ length: doc.lines }, (_, idx) => doc.line(idx + 1).text)
      : (activeEditor ? activeEditor.getContent() : vault.readFile(activeFilePath)).split(/\r?\n/);

    const newActiveLines = [];
    const archivedTasks = [];
    const removedLineRanges = [];

    let currentHeaderStack = [];
    let lastLevel = 1;
    let hierarchyValid = true;

    // Scan and extract completed task trees
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const headerMatch = line.match(/^(#+)\s+(.+)/);

      if (headerMatch) {
        const level = headerMatch[1].length;
        const title = line.trim();

        if (level === 1) {
          newActiveLines.push(line);
          i++;
          continue;
        }

        if (level === 2) {
          currentHeaderStack = [title];
          lastLevel = 2;
          hierarchyValid = true;
        } else {
          if (level > lastLevel + 1) {
            hierarchyValid = false;
          }

          if (hierarchyValid) {
            currentHeaderStack = currentHeaderStack.filter((h) => {
              const hLevel = h.match(/^(#+)/)[1].length;
              return hLevel < level;
            });
            currentHeaderStack.push(title);
            lastLevel = level;
          }
        }
        newActiveLines.push(line);
        i++;
        continue;
      }

      const taskMatch = line.match(/^[-*+]\s+\[([xX ])\]/);
      if (taskMatch) {
        const taskTree = [line];
        let j = i + 1;
        while (j < lines.length && /^(?: {2,}|\t)/.test(lines[j])) {
          taskTree.push(lines[j]);
          j++;
        }

        const hasL2Parent = currentHeaderStack.some((h) => h.startsWith('## '));
        const isAtRoot = currentHeaderStack.length === 0;
        const isEligibleLocation = hierarchyValid && (isAtRoot || hasL2Parent);

        const allItemsFinished = taskTree.every((taskLine) => {
          const checkboxMatch = taskLine.match(/^\s*(?:[-*+])\s+\[(.)\]/);
          if (checkboxMatch) return checkboxMatch[1].toLowerCase() === 'x';
          return true;
        });

        if (allItemsFinished && isEligibleLocation) {
          archivedTasks.push({
            headerPath: [...currentHeaderStack],
            tree: taskTree,
          });
          removedLineRanges.push({ startLine: i, endLine: j - 1 });
        } else {
          newActiveLines.push(...taskTree);
        }
        i = j;
      } else {
        newActiveLines.push(line);
        i++;
      }
    }

    if (archivedTasks.length === 0) {
      this.app.notify({
        title: 'Archive Tasks',
        body: 'No eligible completed tasks found.',
        type: 'info',
      });
      return;
    }

    // Update the active source note without resetting scroll/cursor
    let newActiveContent = newActiveLines.join('\n');

    if (doc && typeof activeEditor.view.dispatch === 'function') {
      const deletions = buildDeletionChanges(doc, removedLineRanges);
      const sel = activeEditor.view.state.selection?.main;
      const selection = sel
        ? {
            anchor: mapPosThroughDeletions(sel.anchor, deletions),
            head: mapPosThroughDeletions(sel.head, deletions),
          }
        : undefined;

      activeEditor.view.dispatch({
        changes: deletions,
        selection,
        scrollIntoView: false,
      });
      restoreScrollPositions(savedScroll, activeEditor);
      newActiveContent = activeEditor.getContent();
    } else if (activeEditor && typeof activeEditor.setContent === 'function') {
      activeEditor.setContent(newActiveContent);
      restoreScrollPositions(savedScroll, activeEditor);
    }
    vault.writeFile(activeFilePath, newActiveContent);
    cache.updateFile(activeFilePath, newActiveContent);
    if (activeTabId) {
      workspace.syncTabsForFile(activeFilePath, newActiveContent, activeTabId);
    }
    events.emit('file-modified', activeFilePath);

    // Ensure archive folder exists on disk if vault.path is available
    if (vault.path) {
      try {
        const absArchiveDir = path.join(vault.path, ...archiveFolder.split('/'));
        if (!fs.existsSync(absArchiveDir)) {
          fs.mkdirSync(absArchiveDir, { recursive: true });
        }
      } catch (_) {}
    }

    // Read or create the destination monthly archive note
    let archiveContent = '';
    if (vault.exists(archivePath)) {
      archiveContent = vault.readFile(archivePath);
    }

    const archiveLines = archiveContent ? archiveContent.split(/\r?\n/) : [];

    // Preserve existing frontmatter if present
    let insertStartIndex = 0;
    if (archiveLines[0] && archiveLines[0].trim() === '---') {
      const endYamlIndex = archiveLines.indexOf('---', 1);
      if (endYamlIndex !== -1) insertStartIndex = endYamlIndex + 1;
    }

    const yamlHeader = archiveLines.slice(0, insertStartIndex);
    const body = archiveLines.slice(insertStartIndex).filter((l) => l.trim() !== '');

    // Ensure Top-Level H1 for the source note (# Note Title)
    let h1Index = body.findIndex((l) => l.trim() === `# ${sourceTitle}`);
    if (h1Index === -1) {
      body.unshift(`# ${sourceTitle}`);
      h1Index = 0;
    }

    // Process tasks bottom-up (reverse preserves document order when spliced)
    for (const taskObj of archivedTasks.reverse()) {
      let currentParentIndex = h1Index;
      let currentLevel = 1;

      for (const headerTitle of taskObj.headerPath) {
        const headerLevel = headerTitle.match(/^(#+)/)[1].length;

        let boundaryIndex = body.findIndex((l, idx) => {
          if (idx <= currentParentIndex) return false;
          const m = l.match(/^(#+)/);
          return m && m[1].length <= currentLevel;
        });
        if (boundaryIndex === -1) boundaryIndex = body.length;

        let foundIndex = -1;
        for (let k = currentParentIndex + 1; k < boundaryIndex; k++) {
          if (body[k].trim() === headerTitle) {
            foundIndex = k;
            break;
          }
        }

        if (foundIndex === -1) {
          body.splice(currentParentIndex + 1, 0, headerTitle);
          foundIndex = currentParentIndex + 1;
        }

        currentParentIndex = foundIndex;
        currentLevel = headerLevel;
      }

      body.splice(currentParentIndex + 1, 0, ...taskObj.tree);
    }

    // Write final content to monthly archive note
    const finalArchiveContent = [...yamlHeader, ...body].join('\n');
    vault.writeFile(archivePath, finalArchiveContent);
    cache.updateFile(archivePath, finalArchiveContent);
    workspace.syncTabsForFile(archivePath, finalArchiveContent, activeTabId || '');
    events.emit('file-modified', archivePath);

    this.app.notify({
      title: 'Tasks Archived',
      body: `Archived ${archivedTasks.length} task(s) to ${archiveFileName}`,
      type: 'success',
    });
  }
};
