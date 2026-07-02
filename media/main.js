// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    subtitle: document.getElementById('subtitle'),
    chkAiMode: document.getElementById('chk-ai-mode'),
    aiUsageLine: document.getElementById('ai-usage-line'),
    btnToday: document.getElementById('btn-today'),
    btnYesterday: document.getElementById('btn-yesterday'),
    btnWeekly: document.getElementById('btn-weekly'),
    btnMonthly: document.getElementById('btn-monthly'),
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
    folderName: document.getElementById('folder-name'),
    loading: document.getElementById('loading'),
    loadingMessage: document.getElementById('loading-message'),
    empty: document.getElementById('empty'),
    error: document.getElementById('error'),
    errorMessage: document.getElementById('error-message'),
    content: document.getElementById('content'),
    notices: document.getElementById('notices'),
    aiStatus: document.getElementById('ai-status'),
    workTitle: document.getElementById('work-title'),
    workList: document.getElementById('work-list'),
    detailsCount: document.getElementById('details-count'),
    detailsBody: document.getElementById('details-body'),
    footerStats: document.getElementById('footer-stats')
  };

  const STATE_ELEMENT_IDS = ['loading', 'empty', 'error', 'content'];
  const GENERATE_BUTTONS = [el.btnToday, el.btnYesterday, el.btnWeekly, el.btnMonthly, el.btnCustom, el.btnClear];
  const MAX_CUSTOM_RANGE_DAYS = 31;

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

  function render(result) {
    const hasWorkItems = result.aiSummaryUsed && result.workItems.length > 0;
    const hasBullets = result.bullets.length > 0;
    const hasContent = hasWorkItems || hasBullets;

    el.btnCopy.disabled = !hasContent;
    el.btnExport.disabled = !hasContent;
    el.folderName.textContent = result.workspaceFolderName;
    el.subtitle.textContent = `Last generated ${new Date(result.generatedAt).toLocaleTimeString()}`;

    el.aiStatus.classList.toggle('hidden', !hasWorkItems);
    el.aiStatus.textContent = hasWorkItems ? '✨ AI-enhanced (Groq) — this run used AI-generated descriptions' : '';

    renderNotices(result.notices);

    if (!hasContent) {
      showState('empty');
      return;
    }

    el.workTitle.textContent =
      `${getPeriodWorkLabel(result.period)} — ${result.workspaceFolderName} (${formatDateRangeLabel(result.dateRange)})`;
    el.workList.innerHTML = '';
    el.workList.appendChild(hasWorkItems ? buildWorkItemsList(result.workItems) : buildBulletsList(result.bullets));

    renderDetails(result);

    el.footerStats.textContent =
      `${pluralize(result.stats.commitCount, 'commit')} · ${pluralize(result.stats.filesChangedCount, 'file')} changed`;

    showState('content');
  }

  function renderStatus(status) {
    el.chkAiMode.checked = status.aiModeEnabled;
    const limitReached = status.aiUsageUsed >= status.aiUsageLimit;
    el.aiUsageLine.textContent = `AI summaries today: ${status.aiUsageUsed} of ${status.aiUsageLimit} used`;
    el.aiUsageLine.classList.toggle('limit-reached', limitReached);

    const showCommitMessage = status.hasUncommittedChanges && status.hasApiKey;
    el.commitMessageSection.classList.toggle('hidden', !showCommitMessage);
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

  function renderNotices(notices) {
    el.notices.innerHTML = '';
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

      el.notices.appendChild(row);
    }
  }

  function renderDetails(result) {
    el.detailsCount.textContent = String(result.stats.filesChangedCount);
    el.detailsBody.innerHTML = '';

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

      el.detailsBody.appendChild(section);
    }
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
  el.btnToday.addEventListener('click', () => vscode.postMessage({ type: 'generatePeriod', period: 'today' }));
  el.btnYesterday.addEventListener('click', () => vscode.postMessage({ type: 'generatePeriod', period: 'yesterday' }));
  el.btnWeekly.addEventListener('click', () => vscode.postMessage({ type: 'generatePeriod', period: 'weekly' }));
  el.btnMonthly.addEventListener('click', () => vscode.postMessage({ type: 'generatePeriod', period: 'monthly' }));
  el.btnCustom.addEventListener('click', () => {
    const startDate = el.customStart.value;
    const endDate = el.customEnd.value;
    const error = validateCustomRangeClient(startDate, endDate);
    el.customRangeError.textContent = error || '';
    el.customRangeError.classList.toggle('hidden', !error);
    if (error) {
      return;
    }
    vscode.postMessage({ type: 'generateCustom', startDate, endDate });
  });
  el.btnClear.addEventListener('click', () => vscode.postMessage({ type: 'clearSummary' }));
  el.btnCopy.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  el.btnExport.addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  el.btnSelectFolder.addEventListener('click', () => vscode.postMessage({ type: 'selectFolder' }));
  el.btnCommitMessage.addEventListener('click', () => vscode.postMessage({ type: 'generateCommitMessage' }));

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
        vscode.setState({ lastResult: message.payload });
        render(message.payload);
        break;
      case 'error':
        el.errorMessage.textContent = message.message;
        showState('error');
        break;
      case 'clear':
        vscode.setState(undefined);
        showState('empty');
        break;
      case 'status':
        renderStatus(message.payload);
        break;
      case 'commitMessageLoading':
        el.btnCommitMessage.disabled = message.value;
        el.commitMessageBtnLabel.textContent = message.value ? 'Generating…' : 'Generate Commit Message';
        break;
    }
  });

  const previousState = vscode.getState();
  if (previousState && previousState.lastResult) {
    render(previousState.lastResult);
  } else {
    showState('empty');
  }

  vscode.postMessage({ type: 'ready' });
})();
