import { t, escapeHtml } from './ui.js';

type OnboardingStatus =
  | 'starting'
  | 'waiting_for_scan'
  | 'verifying'
  | 'configuring_permissions'
  | 'waiting_for_platform_scan'
  | 'completed'
  | 'failed';

type OnboardingPermission = {
  ok: boolean;
  scopeCount?: number;
  skippedScopeCount?: number;
  versionId?: string;
  scopeWarning?: string;
  reason?: string;
  message?: string;
};

type RemainingStep = { title: string; url: string };

type OnboardingJob = {
  id: string;
  status: OnboardingStatus;
  qrUrl?: string;
  qrDataUrl?: string;
  platformQrDataUrl?: string;
  permissionStatusMsg?: string;
  appId?: string;
  cliId?: string;
  workingDir?: string;
  addedBotIndex?: number;
  permission?: OnboardingPermission;
  remainingSteps?: RemainingStep[];
  error?: string;
  message?: string;
};

type CliOption = { id: string; label: string };

let dialog: HTMLDialogElement | null = null;
let pollTimer: number | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'onboarding-dialog';
  document.body.appendChild(dialog);
  dialog.addEventListener('close', stopPolling);
  return dialog;
}

function statusText(job: OnboardingJob): string {
  if (job.status === 'waiting_for_scan') return t('botOnboarding.waiting');
  if (job.status === 'verifying') return t('botOnboarding.verifying');
  if (job.status === 'configuring_permissions') {
    return job.permissionStatusMsg
      ? `${t('botOnboarding.configuringPermissions')} ${job.permissionStatusMsg}`
      : t('botOnboarding.configuringPermissions');
  }
  if (job.status === 'waiting_for_platform_scan') return t('botOnboarding.platformScanHint');
  if (job.status === 'completed') return t('botOnboarding.completed');
  if (job.status === 'failed') return `${t('botOnboarding.failed')}: ${escapeHtml(job.message ?? job.error ?? 'unknown')}`;
  return t('botOnboarding.starting');
}

/** 完成页的权限摘要 / 手动兜底步骤. */
function permissionBlock(job: OnboardingJob): string {
  if (job.status !== 'completed' || !job.permission) return '';
  const p = job.permission;
  if (p.ok) {
    const parts = [t('botOnboarding.permissionOk', { count: p.scopeCount ?? 0 })];
    if (p.skippedScopeCount && p.skippedScopeCount > 0) {
      parts.push(t('botOnboarding.permissionSkipped', { count: p.skippedScopeCount }));
    }
    if (p.versionId) parts.push(t('botOnboarding.permissionVersion', { version: escapeHtml(p.versionId) }));
    let html = `<p class="hint-ok">✅ ${parts.join(' ')}</p>`;
    if (p.scopeWarning) html += `<p class="hint-warn">⚠️ ${escapeHtml(p.scopeWarning)}</p>`;
    return html;
  }
  // 自动配置失败 → 手动步骤深链
  const steps = (job.remainingSteps ?? [])
    .map(s => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></li>`)
    .join('');
  return `<p class="hint-warn">⚠️ ${t('botOnboarding.permissionManual')}${p.message ? `（${escapeHtml(p.message)}）` : ''}</p>`
    + (steps ? `<ol class="onboarding-steps">${steps}</ol>` : '');
}

function renderJob(job: OnboardingJob): void {
  const d = ensureDialog();
  // 第 1 个二维码: 扫码建应用
  const appQr = job.status === 'waiting_for_scan' && job.qrDataUrl
    ? `<div class="qr-card">
        <img class="qr-image" src="${job.qrDataUrl}" alt="${t('botOnboarding.qrAlt')}">
        ${job.qrUrl ? `<a class="onboarding-link" href="${escapeHtml(job.qrUrl)}" target="_blank" rel="noopener">${t('botOnboarding.openLink')}</a>` : ''}
      </div>`
    : '';
  // 第 2 个二维码: 扫码登录开放平台 (自动配权限用; 它是 payload, 没有可点链接)
  const platformQr = job.status === 'waiting_for_platform_scan' && job.platformQrDataUrl
    ? `<div class="qr-card">
        <img class="qr-image" src="${job.platformQrDataUrl}" alt="${t('botOnboarding.platformQrAlt')}">
      </div>`
    : '';
  const metaLine = job.appId
    ? `<p><b>App ID:</b> <code>${escapeHtml(job.appId)}</code>`
      + (job.cliId ? ` ｜ <b>CLI:</b> <code>${escapeHtml(job.cliId)}</code>` : '')
      + (job.workingDir ? ` ｜ <b>${t('botOnboarding.metaDir')}:</b> <code>${escapeHtml(job.workingDir)}</code>` : '')
      + `</p>`
    : '';
  const restartHint = job.status === 'completed'
    ? `<p class="hint-ok">${t('botOnboarding.restartHint')}</p>`
    : '';
  d.innerHTML = `<article>
    <header>
      <h3>${t('botOnboarding.title')}</h3>
      <p>${t('botOnboarding.intro')}</p>
    </header>
    <p class="onboarding-status status-${job.status}">${statusText(job)}</p>
    ${appQr}
    ${platformQr}
    ${metaLine}
    ${permissionBlock(job)}
    ${restartHint}
    <form method="dialog"><button>${t('botOnboarding.close')}</button></form>
  </article>`;
}

async function fetchCliOptions(): Promise<CliOption[]> {
  try {
    const res = await fetch('/api/cli-options');
    const body = await res.json();
    if (res.ok && Array.isArray(body?.options)) return body.options as CliOption[];
  } catch { /* fall through to default */ }
  return [{ id: 'claude-code', label: 'Claude' }];
}

function renderForm(options: CliOption[], errorMsg?: string): void {
  const d = ensureDialog();
  const optionHtml = options
    .map(o => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}（${escapeHtml(o.id)}）</option>`)
    .join('');
  const errorHtml = errorMsg ? `<p class="form-error">${escapeHtml(errorMsg)}</p>` : '';
  d.innerHTML = `<article>
    <header>
      <h3>${t('botOnboarding.title')}</h3>
      <p>${t('botOnboarding.intro')}</p>
    </header>
    <form id="onboarding-form" class="onboarding-form">
      <label class="onboarding-field">
        <span>${t('botOnboarding.cliLabel')}</span>
        <select id="ob-cli">${optionHtml}</select>
      </label>
      <label class="onboarding-field">
        <span>${t('botOnboarding.dirLabel')}</span>
        <input id="ob-dir" type="text" value="~" placeholder="${t('botOnboarding.dirPlaceholder')}" autocomplete="off" spellcheck="false">
      </label>
      <label class="onboarding-field">
        <span>${t('botOnboarding.modelLabel')}</span>
        <input id="ob-model" type="text" placeholder="${t('botOnboarding.modelPlaceholder')}" autocomplete="off" spellcheck="false">
      </label>
      ${errorHtml}
      <menu class="onboarding-actions">
        <button type="button" id="ob-cancel">${t('botOnboarding.cancel')}</button>
        <button type="submit" class="primary">${t('botOnboarding.startScan')}</button>
      </menu>
    </form>
  </article>`;

  const form = d.querySelector<HTMLFormElement>('#onboarding-form');
  const cancel = d.querySelector<HTMLButtonElement>('#ob-cancel');
  cancel?.addEventListener('click', () => d.close());
  form?.addEventListener('submit', ev => {
    ev.preventDefault();
    const cliId = d.querySelector<HTMLSelectElement>('#ob-cli')?.value ?? '';
    const workingDir = d.querySelector<HTMLInputElement>('#ob-dir')?.value ?? '';
    const model = d.querySelector<HTMLInputElement>('#ob-model')?.value ?? '';
    void startOnboarding({ cliId, workingDir, model }, options);
  });
}

async function startOnboarding(
  input: { cliId: string; workingDir: string; model: string },
  options: CliOption[],
): Promise<void> {
  stopPolling();
  renderJob({ id: '', status: 'starting' });
  try {
    const res = await fetch('/api/bot-onboarding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cliId: input.cliId,
        workingDir: input.workingDir.trim(),
        model: input.model.trim() || undefined,
      }),
    });
    const body = await res.json();
    // 校验类错误 (目录不存在 / CLI 非法): 回到表单内联报错, 不丢用户已填的值.
    if (res.status === 400) {
      renderForm(options, body?.message ?? body?.error ?? 'invalid_input');
      return;
    }
    if (!res.ok || !body?.job?.id) throw new Error(body?.error ?? `http_${res.status}`);
    renderJob(body.job);
    pollTimer = window.setInterval(() => {
      void pollJob(body.job.id).catch(err => {
        stopPolling();
        renderJob({ id: body.job.id, status: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    }, 1200);
  } catch (err) {
    renderJob({ id: '', status: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

async function pollJob(id: string): Promise<void> {
  const res = await fetch(`/api/bot-onboarding/${encodeURIComponent(id)}`);
  const body = await res.json();
  if (!res.ok || !body?.job) throw new Error(body?.error ?? `http_${res.status}`);
  renderJob(body.job);
  if (body.job.status === 'completed' || body.job.status === 'failed') stopPolling();
}

async function openBotOnboarding(): Promise<void> {
  stopPolling();
  const d = ensureDialog();
  // 先出表单 (含 CLI 下拉占位), 再异步填充选项——避免空白等待.
  renderForm([{ id: 'claude-code', label: 'Claude' }]);
  if (!d.open) d.showModal();
  const options = await fetchCliOptions();
  // 用户可能在 fetch 期间已经提交/关闭; 仅当仍停留在表单时刷新选项.
  if (d.open && d.querySelector('#onboarding-form')) renderForm(options);
}

export function wireBotOnboardingButton(): void {
  const btn = document.getElementById('add-bot-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = () => { void openBotOnboarding(); };
}
