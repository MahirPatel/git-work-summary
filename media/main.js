// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    subtitle: document.getElementById('subtitle'),
    btnShare: document.getElementById('btn-share'),
    chkAiMode: document.getElementById('chk-ai-mode'),
    aiUsageLine: document.getElementById('ai-usage-line'),
    chkTeamWise: document.getElementById('chk-team-wise'),
    repoSelect: document.getElementById('repo-select'),
    repoSelectList: document.getElementById('repo-select-list'),
    btnToday: document.getElementById('btn-today'),
    btnYesterday: document.getElementById('btn-yesterday'),
    btnWeekly: document.getElementById('btn-weekly'),
    btnMonthly: document.getElementById('btn-monthly'),
    btnToggleCustomRange: document.getElementById('btn-toggle-custom-range'),
    customRange: document.getElementById('custom-range'),
    customStart: document.getElementById('custom-start'),
    customEnd: document.getElementById('custom-end'),
    btnCustom: document.getElementById('btn-custom'),
    customRangeError: document.getElementById('custom-range-error'),
    btnClear: document.getElementById('btn-clear'),
    btnCopy: document.getElementById('btn-copy'),
    btnExport: document.getElementById('btn-export'),
    btnSelectFolder: document.getElementById('btn-select-folder'),
    commitMessageSection: document.getElementById('commit-message-section'),
    btnCommitMessage: document.getElementById('btn-commit-message'),
    commitMessageBtnLabel: document.getElementById('commit-message-btn-label'),
    commitMessageResult: document.getElementById('commit-message-result'),
    commitMessageText: document.getElementById('commit-message-text'),
    btnCopyCommitMessage: document.getElementById('btn-copy-commit-message'),
    folderName: document.getElementById('folder-name'),
    loading: document.getElementById('loading'),
    loadingMessage: document.getElementById('loading-message'),
    empty: document.getElementById('empty'),
    error: document.getElementById('error'),
    errorMessage: document.getElementById('error-message'),
    content: document.getElementById('content'),
    resultsContainer: document.getElementById('results-container')
  };

  const STATE_ELEMENT_IDS = ['loading', 'empty', 'error', 'content'];
  const GENERATE_BUTTONS = [el.btnToday, el.btnYesterday, el.btnWeekly, el.btnMonthly, el.btnCustom, el.btnClear];
  const MAX_CUSTOM_RANGE_DAYS = 31;

  /** Selected repo checkbox state - source of truth for which folders a Generate click covers. */
  let selectedFolderPaths = new Set();
  /** Sorted-joined key of the last-seen workspace folder set, so `renderWorkspaceFolders` only rebuilds the checkbox list (and only resets selection) on an actual add/remove, not on every routine status refresh. */
  let knownFolderPathsKey = '';

  /** @param {'loading'|'empty'|'error'|'content'} name */
  function showState(name) {
    for (const id of STATE_ELEMENT_IDS) {
      el[id].classList.toggle('hidden', id !== name);
    }
  }

  function pluralize(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  function toDateIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseDateIso(dateStr) {
    const date = new Date(`${dateStr}T00:00:00`);
    return isNaN(date.getTime()) ? undefined : date;
  }

  function formatLong(dateStr) {
    const date = parseDateIso(dateStr);
    if (!date) return dateStr;
    return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatShort(dateStr) {
    const date = parseDateIso(dateStr);
    if (!date) return dateStr;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDateRangeLabel(range) {
    if (range.startDate === range.endDate) {
      return formatLong(range.startDate);
    }
    return `${formatShort(range.startDate)} – ${formatShort(range.endDate)}`;
  }

  function getPeriodWorkLabel(period) {
    switch (period) {
      case 'today':
        return "Today's Work";
      case 'yesterday':
        return "Yesterday's Work";
      case 'weekly':
        return "This Week's Work";
      case 'monthly':
        return "This Month's Work";
      case 'custom':
        return 'Custom Range Summary';
      default:
        return 'Work Summary';
    }
  }

  /** Mirrors the server-side validateCustomRange for instant feedback; the host re-validates authoritatively. */
  function validateCustomRangeClient(startStr, endStr) {
    if (!startStr || !endStr) {
      return 'Pick both a start and end date.';
    }
    const start = parseDateIso(startStr);
    const end = parseDateIso(endStr);
    if (!start || !end) {
      return 'Please enter valid dates.';
    }
    if (start.getTime() > end.getTime()) {
      return 'Start date must be on or before the end date.';
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (end.getTime() > today.getTime()) {
      return 'End date cannot be in the future.';
    }
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
      return `That range is ${spanDays} days — the maximum is ${MAX_CUSTOM_RANGE_DAYS} days.`;
    }
    return undefined;
  }

  /** Builds one repo's full block: optional heading, AI banner, notices, work title, work list, details, stats. Used for both the single-repo (no heading) and multi-repo (headed, stacked) cases. */
  function buildRepoBlock(result, { showHeading }) {
    const block = document.createElement('div');
    block.className = 'repo-block';

    if (showHeading) {
      const heading = document.createElement('h2');
      heading.className = 'repo-heading';
      heading.textContent = result.workspaceFolderName;
      block.appendChild(heading);
    }

    const hasWorkItems = result.aiSummaryUsed && result.workItems.length > 0;
    const hasBullets = result.bullets.length > 0;
    const hasRepoContent = hasWorkItems || hasBullets;

    if (hasWorkItems) {
      const banner = document.createElement('p');
      banner.className = 'ai-status';
      banner.textContent = '✨ AI-enhanced (Groq) — this run used AI-generated descriptions';
      block.appendChild(banner);
    }

    block.appendChild(buildNoticesBlock(result.notices));

    const workTitle = document.createElement('h3');
    workTitle.className = 'section-title';
    workTitle.textContent = showHeading
      ? `${getPeriodWorkLabel(result.period)} (${formatDateRangeLabel(result.dateRange)})`
      : `${getPeriodWorkLabel(result.period)} — ${result.workspaceFolderName} (${formatDateRangeLabel(result.dateRange)})`;
    block.appendChild(workTitle);

    const workList = document.createElement('div');
    if (!hasRepoContent) {
      const emptyHint = document.createElement('p');
      emptyHint.className = 'hint';
      emptyHint.textContent = 'No development activity detected for this period.';
      workList.appendChild(emptyHint);
    } else if (result.teamWiseSummaryUsed && hasWorkItems && result.workItemGroups) {
      workList.appendChild(buildGroupedList(result.workItemGroups, (group) => buildWorkItemsList(group.items)));
    } else if (result.teamWiseSummaryUsed && !hasWorkItems && hasBullets && result.bulletGroups) {
      workList.appendChild(buildGroupedList(result.bulletGroups, (group) => buildBulletsList(group.bullets)));
    } else {
      workList.appendChild(hasWorkItems ? buildWorkItemsList(result.workItems) : buildBulletsList(result.bullets));
    }
    block.appendChild(workList);

    block.appendChild(buildDetailsBlock(result));

    const stats = document.createElement('p');
    stats.className = 'footer-stats';
    stats.textContent =
      `${pluralize(result.stats.commitCount, 'commit')} · ${pluralize(result.stats.filesChangedCount, 'file')} changed`;
    block.appendChild(stats);

    return block;
  }

  function render(results) {
    const hasAnyContent = results.some((r) => (r.aiSummaryUsed && r.workItems.length > 0) || r.bullets.length > 0);

    el.btnCopy.disabled = !hasAnyContent;
    el.btnExport.disabled = !hasAnyContent;
    el.subtitle.textContent = `Last generated ${new Date().toLocaleTimeString()}`;

    if (!hasAnyContent) {
      showState('empty');
      return;
    }

    el.resultsContainer.innerHTML = '';
    const showHeading = results.length > 1;
    for (const result of results) {
      el.resultsContainer.appendChild(buildRepoBlock(result, { showHeading }));
    }

    showState('content');
  }

  function renderCommitMessage(message) {
    el.commitMessageText.textContent = message;
    el.commitMessageResult.classList.toggle('hidden', !message);
  }

  function renderStatus(status) {
    el.chkAiMode.checked = status.aiModeEnabled;
    el.chkTeamWise.checked = status.teamWiseSummaryEnabled;
    el.folderName.textContent = status.defaultFolderName || '';
    renderWorkspaceFolders(status.workspaceFolders);
    const limitReached = status.aiUsageUsed >= status.aiUsageLimit;
    el.aiUsageLine.textContent = `AI summaries today: ${status.aiUsageUsed} of ${status.aiUsageLimit} used`;
    el.aiUsageLine.classList.toggle('limit-reached', limitReached);

    const showCommitMessage = status.hasUncommittedChanges && status.hasApiKey;
    el.commitMessageSection.classList.toggle('hidden', !showCommitMessage);
  }

  function saveSelectedFolderPaths() {
    vscode.setState({ ...vscode.getState(), selectedFolderPaths: [...selectedFolderPaths] });
  }

  function getSelectedFolderPaths() {
    return [...selectedFolderPaths];
  }

  /**
   * Rebuilds the repo checkbox list, but only when the actual set of
   * workspace folders changed since last time - `status` messages (and thus
   * this function) fire frequently (every generate, toggle, API-key change,
   * and a 600ms-debounced timer after any file save anywhere in the
   * workspace), so rebuilding/resetting on every call would silently wipe
   * out the user's mid-session checkbox selections.
   */
  function renderWorkspaceFolders(folders) {
    const key = [...folders].map((f) => f.path).sort().join('|');
    if (key === knownFolderPathsKey) {
      return;
    }
    knownFolderPathsKey = key;

    const nextPaths = new Set(folders.map((f) => f.path));
    const intersected = new Set([...selectedFolderPaths].filter((p) => nextPaths.has(p)));
    selectedFolderPaths = intersected.size > 0 ? intersected : new Set(folders.length > 0 ? [folders[0].path] : []);
    saveSelectedFolderPaths();

    el.repoSelect.classList.toggle('hidden', folders.length <= 1);
    el.repoSelectList.innerHTML = '';
    for (const folder of folders) {
      const label = document.createElement('label');
      label.className = 'repo-check-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedFolderPaths.has(folder.path);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedFolderPaths.add(folder.path);
        } else {
          selectedFolderPaths.delete(folder.path);
        }
        saveSelectedFolderPaths();
      });

      const span = document.createElement('span');
      span.textContent = folder.name;

      label.appendChild(checkbox);
      label.appendChild(span);
      el.repoSelectList.appendChild(label);
    }
  }

  function buildBulletsList(bullets) {
    const ul = document.createElement('ul');
    ul.className = 'bullets';
    for (const bullet of bullets) {
      const li = document.createElement('li');
      li.textContent = bullet;
      ul.appendChild(li);
    }
    return ul;
  }

  /** Renders Team Wise Summary groups as "Author: Name" headings, each followed by that author's items built via `buildItems`. */
  function buildGroupedList(groups, buildItems) {
    const container = document.createElement('div');
    for (const group of groups) {
      const heading = document.createElement('h4');
      heading.className = 'author-heading';
      heading.textContent = `Author: ${group.author}`;
      container.appendChild(heading);
      container.appendChild(buildItems(group));
    }
    return container;
  }

  function buildWorkItemsList(workItems) {
    const ul = document.createElement('ul');
    ul.className = 'work-items';
    for (const item of workItems) {
      const li = document.createElement('li');

      const title = document.createElement('strong');
      title.textContent = item.title;
      li.appendChild(title);

      const subUl = document.createElement('ul');
      if (item.commitMessage) {
        const commitLi = document.createElement('li');
        commitLi.textContent = `Commit Message : ${item.commitMessage}`;
        subUl.appendChild(commitLi);
      }
      const descLi = document.createElement('li');
      descLi.textContent = `Description: ${item.description}`;
      subUl.appendChild(descLi);

      li.appendChild(subUl);
      ul.appendChild(li);
    }
    return ul;
  }

  function buildNoticesBlock(notices) {
    const container = document.createElement('div');
    container.className = 'notices';
    for (const notice of notices) {
      const row = document.createElement('div');
      row.className = 'notice';

      const icon = document.createElement('span');
      icon.className = 'codicon codicon-warning';
      row.appendChild(icon);

      const needsApiKey = notice.includes('Set Groq API Key');
      const text = document.createElement('span');
      text.textContent = needsApiKey ? 'AI summary needs a Groq API key.' : notice;
      row.appendChild(text);

      if (needsApiKey) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'btn-link notice-action';
        link.textContent = 'Set API Key';
        link.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
        row.appendChild(link);
      }

      container.appendChild(row);
    }
    return container;
  }

  function buildDetailsBlock(result) {
    const details = document.createElement('details');
    details.className = 'details-section';

    const summary = document.createElement('summary');
    summary.textContent = `Files touched (${result.stats.filesChangedCount})`;
    details.appendChild(summary);

    const body = document.createElement('div');
    for (const detail of result.details) {
      const section = document.createElement('div');
      section.className = 'detail-category';

      const heading = document.createElement('h4');
      heading.textContent = `${detail.category} (${detail.files.length})`;
      section.appendChild(heading);

      for (const file of detail.files) {
        const row = document.createElement('div');
        row.className = 'detail-file';

        const pathSpan = document.createElement('span');
        pathSpan.className = 'path';
        pathSpan.textContent = file.relativePath;

        const langSpan = document.createElement('span');
        langSpan.className = 'lang';
        langSpan.textContent = file.language;

        row.appendChild(pathSpan);
        row.appendChild(langSpan);
        section.appendChild(row);
      }

      body.appendChild(section);
    }
    details.appendChild(body);

    return details;
  }

  function setGenerateButtonsDisabled(disabled) {
    for (const btn of GENERATE_BUTTONS) {
      btn.disabled = disabled;
    }
  }

  // --- Default custom-range inputs: last 7 days, end capped at today ---
  const todayIso = toDateIso(new Date());
  const weekAgoIso = toDateIso(new Date(Date.now() - 6 * 86400000));
  el.customStart.max = todayIso;
  el.customEnd.max = todayIso;
  el.customStart.value = weekAgoIso;
  el.customEnd.value = todayIso;

  el.chkAiMode.addEventListener('change', () =>
    vscode.postMessage({ type: 'setAiMode', enabled: el.chkAiMode.checked })
  );
  el.chkTeamWise.addEventListener('change', () =>
    vscode.postMessage({ type: 'setTeamWiseSummary', enabled: el.chkTeamWise.checked })
  );
  el.btnToday.addEventListener('click', () =>
    vscode.postMessage({ type: 'generatePeriod', period: 'today', folderPaths: getSelectedFolderPaths() })
  );
  el.btnYesterday.addEventListener('click', () =>
    vscode.postMessage({ type: 'generatePeriod', period: 'yesterday', folderPaths: getSelectedFolderPaths() })
  );
  el.btnWeekly.addEventListener('click', () =>
    vscode.postMessage({ type: 'generatePeriod', period: 'weekly', folderPaths: getSelectedFolderPaths() })
  );
  el.btnMonthly.addEventListener('click', () =>
    vscode.postMessage({ type: 'generatePeriod', period: 'monthly', folderPaths: getSelectedFolderPaths() })
  );
  el.btnCustom.addEventListener('click', () => {
    const startDate = el.customStart.value;
    const endDate = el.customEnd.value;
    const error = validateCustomRangeClient(startDate, endDate);
    el.customRangeError.textContent = error || '';
    el.customRangeError.classList.toggle('hidden', !error);
    if (error) {
      return;
    }
    vscode.postMessage({ type: 'generateCustom', startDate, endDate, folderPaths: getSelectedFolderPaths() });
  });
  el.btnClear.addEventListener('click', () => vscode.postMessage({ type: 'clearSummary' }));
  el.btnCopy.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  el.btnExport.addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  el.btnSelectFolder.addEventListener('click', () => vscode.postMessage({ type: 'selectFolder' }));
  el.btnShare.addEventListener('click', () => vscode.postMessage({ type: 'shareExtension' }));
  el.btnCommitMessage.addEventListener('click', () => vscode.postMessage({ type: 'generateCommitMessage' }));
  el.btnCopyCommitMessage.addEventListener('click', () =>
    vscode.postMessage({ type: 'copyCommitMessage', message: el.commitMessageText.textContent || '' })
  );
  el.btnToggleCustomRange.addEventListener('click', () => {
    const expanded = el.btnToggleCustomRange.getAttribute('aria-expanded') === 'true';
    el.btnToggleCustomRange.setAttribute('aria-expanded', String(!expanded));
    el.customRange.classList.toggle('hidden', expanded);
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'loading':
        setGenerateButtonsDisabled(message.value);
        if (message.value) {
          el.loadingMessage.textContent = 'Generating your summary…';
          showState('loading');
        }
        break;
      case 'result':
        vscode.setState({ ...vscode.getState(), lastResult: message.payload });
        render(message.payload);
        break;
      case 'error':
        el.errorMessage.textContent = message.message;
        showState('error');
        break;
      case 'clear':
        vscode.setState({ ...vscode.getState(), lastResult: undefined });
        showState('empty');
        break;
      case 'status':
        renderStatus(message.payload);
        break;
      case 'commitMessageLoading':
        el.btnCommitMessage.disabled = message.value;
        el.commitMessageBtnLabel.textContent = message.value ? 'Generating…' : 'Generate Commit Message';
        break;
      case 'commitMessageResult':
        vscode.setState({ ...vscode.getState(), lastCommitMessage: message.message });
        renderCommitMessage(message.message);
        break;
    }
  });

  const previousState = vscode.getState();
  if (previousState && Array.isArray(previousState.selectedFolderPaths)) {
    selectedFolderPaths = new Set(previousState.selectedFolderPaths);
  }
  if (previousState && previousState.lastCommitMessage) {
    renderCommitMessage(previousState.lastCommitMessage);
  }
  if (previousState && previousState.lastResult) {
    // Defensive: a webview state blob cached from before multi-repo support
    // may still hold a single result object rather than an array.
    const lastResults = Array.isArray(previousState.lastResult)
      ? previousState.lastResult
      : [previousState.lastResult];
    render(lastResults);
  } else {
    showState('empty');
  }

  vscode.postMessage({ type: 'ready' });
})();
