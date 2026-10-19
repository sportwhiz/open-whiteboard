import { createDeployment, steps } from './flow.js';
import { preparePreview, previewCall, finishPreview } from './preview.js';
const preview = document.body.dataset.previewOnly === 'true' || new URL(location.href).searchParams.get('preview') === '1';
if (preview) preparePreview();
const $ = id => document.getElementById(id);
function journey(stage) {
  const stages = ['connect', 'configure', 'deploy', 'account'];
  document.querySelectorAll('[data-journey]').forEach((item, index) => {
    item.removeAttribute('aria-current');
    item.dataset.complete = String(index < stages.indexOf(stage));
    item.querySelector('.journey-number').textContent = index < stages.indexOf(stage) ? '✓' : String(index + 1);
    if (item.dataset.journey === stage) item.setAttribute('aria-current', 'step');
  });
}
let attempt = crypto.randomUUID();
let token = ''; let deployment; let inProgress = false; let retryAt = 0; let timer;
const stepGuidance = {
  release: 'Downloading and checking the release before setup begins.',
  create: 'GoDaddy is preparing a place for your whiteboard. This can take a few minutes.',
  attach: 'Connecting your app to the hosting plan you selected.',
  addresses: 'Waiting for GoDaddy to provide your app’s addresses.',
  preview: 'Saving the settings for your separate preview.',
  live: 'Saving the settings for your live whiteboard.',
  upload: 'Sending Open Whiteboard to GoDaddy and waiting for it to process the files. This can take a few minutes.',
  publish: 'Waiting for GoDaddy to build and publish your whiteboard. This can take a few minutes.',
  status: 'Waiting for GoDaddy to confirm your server is running.',
  health: 'Waiting for Open Whiteboard to finish starting and respond to its readiness check.',
};
let stepTimer;
function stopStepActivity(paused = false) {
  clearInterval(stepTimer);
  $('progress-activity').dataset.state = paused ? 'paused' : 'idle';
  if (paused) {
    $('progress-detail').textContent = 'Setup is paused. Check the message below for the next step.';
    $('progress-wait').textContent = 'Keep this page open to preserve your progress.';
  }
}
function startStepActivity(stage) {
  stopStepActivity();
  const started = performance.now();
  $('progress-activity').dataset.state = 'active';
  $('progress-detail').textContent = stepGuidance[stage];
  $('progress-wait').textContent = 'Keep this page open. We’ll check automatically; there’s nothing you need to click.';
  let prolonged = false;
  const tick = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    $('step-elapsed').textContent = `Time waiting: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (seconds >= 60 && !prolonged) {
      prolonged = true;
      $('progress-wait').textContent = 'Still waiting for confirmation. The completed steps are kept, and we’ll show any error here. Keep this page open.';
    }
  };
  tick();
  stepTimer = setInterval(tick, 1000);
}
function showError(error) {
  $('error').textContent = error.message || 'Something went wrong. Please try again.';
  if (error.supportReference) $('error').textContent += ` This failure was recorded. Support reference: ${error.supportReference}.`;
  $('error').hidden = false; $('error').focus();
  if (error.retryAfter) retryAt = Date.now() + error.retryAfter * 1000;
}
async function call(action, values = {}) {
  if (preview) return previewCall(action);
  let response;
  try { response = await fetch(new URL('./api', import.meta.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token, attempt, ...values }) }); }
  catch { throw new Error('The connection was interrupted. Keep this page open and continue to retry the same step.'); }
  let data; try { data = await response.json(); } catch { throw new Error('The installer did not return a response. Continue to retry the same step.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'The request failed.'), { retryAfter: data.retryAfter, status: response.status, supportReference: data.supportReference });
  return data;
}
function retryLabel() {
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  $('retry').disabled = seconds > 0;
  $('retry-failed').disabled = seconds > 0;
  $('retry').textContent = seconds ? `Continue in ${seconds}s` : 'Continue deployment';
  if (!seconds) clearInterval(timer);
}
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); $('error').hidden = true; $('connect').disabled = true; $('connect').textContent = 'Checking your account…'; $('connect').setAttribute('aria-busy', 'true');
  token = $('token').value.trim();
  try {
    const result = await call('connect');
    $('plan').replaceChildren();
    for (const plan of result.plans) {
      const option = document.createElement('option'); option.value = plan.id; option.disabled = !plan.available;
      option.textContent = `${plan.name} · ${plan.available ? `${plan.slots} available ${plan.slots === 1 ? 'slot' : 'slots'}` : 'unavailable'}`;
      $('plan').append(option);
    }
    if (!result.plans.some(plan => plan.available)) throw new Error('No available Node.js Hosting plan was found. Add a plan or free an app slot in your GoDaddy account, then connect again.');
    $('plan').value = result.plans.find(plan => plan.available).id;
    $('version').textContent = preview ? 'example release' : `v${result.release.version}`;
    $('setup-kicker').textContent = 'STEP 2 OF 4 · DETAILS'; $('setup-title').textContent = 'Name your whiteboard.'; $('setup-intro').textContent = 'Choose a name and save your setup passphrase. We’ll fill in the hosting settings for you.'; $('connect-form').hidden = true; $('deploy-form').hidden = false; $('token').value = ''; journey('configure'); $('setup-title').focus(); $('setup').scrollIntoView({ block: 'start' });
  } catch (error) { token = ''; showError(error); }
  finally { $('connect').disabled = false; $('connect').innerHTML = 'Connect GoDaddy <span aria-hidden="true">→</span>'; $('connect').removeAttribute('aria-busy'); }
});
$('disconnect').addEventListener('click', () => {
  attempt = crypto.randomUUID();
  token = ''; $('token').value = preview ? 'example-key-for-this-preview' : ''; $('passphrase').value = preview ? 'Example setup passphrase' : ''; $('passphrase').type = 'password'; $('copy-passphrase').hidden = true; $('copy-passphrase').textContent = 'Copy passphrase'; $('setup-kicker').textContent = 'STEP 1 OF 4 · CONNECT'; $('setup-title').textContent = 'Connect your GoDaddy account.'; $('setup-intro').textContent = 'Create a temporary key in GoDaddy, then paste it here. We’ll check which hosting plans you can use.'; $('deploy-form').hidden = true; $('connect-form').hidden = false; $('error').hidden = true; $('saved-passphrase').checked = false; journey('connect'); $('token').focus();
});
$('deploy-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (deployment) return;
  if ($('passphrase').value.trim().length < 16) { showError(new Error('Choose a setup passphrase with at least 16 characters, excluding surrounding spaces.')); return; }
  deployment = createDeployment({
    call,
    details: { name: $('name').value, planId: $('plan').value, passphrase: $('passphrase').value },
    onStep(stage, state) {
      document.querySelector(`[data-step="${stage}"]`).dataset.state = state;
      const completed = document.querySelectorAll('#steps [data-state=done]').length;
      $('deployment-progress').value = completed;
      $('progress-count').textContent = `${completed} of ${steps.length} steps complete`;
      if (state === 'active') {
        $('progress-title').textContent = steps.find(([id]) => id === stage)[1];
        startStepActivity(stage);
      } else stopStepActivity(state === 'failed');
    },
    onApp(appId) { $('app-id').textContent = `GoDaddy app: ${appId}. Keep this identifier if you need to find the app in your dashboard.`; if (!preview && appId.startsWith('NODEJS-')) { $('manage-app').href = 'https://host.godaddy.com/nodejs/projects/' + encodeURIComponent(appId.slice(7)); $('manage-app').hidden = false; } },
  });
  $('passphrase').value = '';
  $('steps').replaceChildren(...steps.map(([id, label]) => { const li = document.createElement('li'); li.dataset.step = id; li.textContent = label; return li; }));
  $('setup').hidden = true; $('progress').hidden = false; journey('deploy'); $('progress-title').focus(); $('progress').scrollIntoView({ block: 'start' });
  await run();
});
async function run(retryFailed = false) {
  if (inProgress || Date.now() < retryAt) return;
  inProgress = true; $('retry').hidden = true; $('retry-failed').hidden = true; $('error').hidden = true;
  try {
    const addresses = await deployment.run({ retryFailed });
    token = ''; $('token').value = ''; $('progress').hidden = true; $('success').hidden = false;
    journey('account');
    if (preview) finishPreview();
    else { $('open-board').href = addresses.publish; $('success').focus(); }
    $('success').scrollIntoView({ block: 'start' });
    deployment = undefined;
  } catch (error) {
    stopStepActivity(true);
    if (!preview && error.browserTimeout && !error.supportReference) {
      try { const report = await call('report-stalled', { stage: error.stage }); error.supportReference = report.supportReference; } catch { /* Preserve the original failure and recovery controls. */ }
    }
    showError(error);
    const needsKey = [401, 403].includes(error.status);
    $('reconnect-form').hidden = !needsKey;
    $('retry').hidden = needsKey;
    $('retry-failed').hidden = needsKey || !deployment.state.retryStage;
    $('retry').classList.toggle('secondary', Boolean(deployment.state.retryStage));
    $('retry-failed').textContent = deployment.state.retryStage === 'upload' ? 'Upload again to this app' : 'Publish again to this app';
    if (!needsKey) { retryLabel(); timer = setInterval(retryLabel, 1000); }
  }
  finally { stopStepActivity($('progress-activity').dataset.state === 'paused'); inProgress = false; }
}
$('retry').addEventListener('click', () => run());
$('retry-failed').addEventListener('click', () => run(true));
$('reconnect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (inProgress) return;
  $('reconnect').disabled = true;
  $('error').hidden = true;
  token = $('reconnect-token').value.trim();
  $('reconnect-token').value = '';
  try {
    // Verify read access to the existing app before resuming any write.
    if (deployment.state.appId) await call('addresses', { appId: deployment.state.appId });
    else await call('connect');
    $('reconnect-form').hidden = true;
    await run();
  } catch (error) { token = ''; showError(error); }
  finally { $('reconnect').disabled = false; }
});
window.addEventListener('beforeunload', event => { if (deployment) { event.preventDefault(); event.returnValue = ''; } });

$('copy-agent').addEventListener('click', async () => {
  try {
    const response = await fetch(new URL('./agent-prompt.txt', import.meta.url));
    if (!response.ok) throw new Error('Instructions unavailable');
    await navigator.clipboard.writeText(await response.text());
    $('copy-status').textContent = 'Copied. Paste into Claude, Codex, or your coding assistant to start.';
  } catch { $('copy-status').textContent = 'Your browser could not copy. Use “Download instructions instead” below.'; }
});

$('generate-passphrase').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  $('passphrase').value = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  $('saved-passphrase').checked = false;
  $('passphrase').type = 'text'; $('copy-passphrase').hidden = false;
  $('passphrase-help').textContent = 'Save this passphrase in your password manager before deploying. You’ll enter it once to create your administrator account.';
});
$('passphrase').addEventListener('input', () => { $('saved-passphrase').checked = false; });
$('copy-passphrase').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('passphrase').value); $('copy-passphrase').textContent = 'Copied'; }
  catch { $('passphrase').focus(); $('passphrase').select(); $('copy-passphrase').textContent = 'Select and copy the passphrase above'; }
});

// Check the public release gate before asking anyone to create a credential.
const initialSetup = { kicker: $('setup-kicker').textContent, title: $('setup-title').textContent, intro: $('setup-intro').textContent };
async function checkAvailability() {
  $('token').disabled = true;
  $('connect').disabled = true;
  $('check-availability').disabled = true;
  $('error').hidden = true;
  try {
    const status = await call('release-status');
    const available = status.monitoringReady !== false && status.qualified;
    $('connect-form').hidden = !available;
    $('check-availability').hidden = available;
    if (!available) {
      $('setup-kicker').textContent = 'PLEASE TRY AGAIN LATER';
      $('setup-title').textContent = 'The installer is temporarily unavailable.';
      $('setup-intro').textContent = 'Setup will open after our installation checks pass. You do not need to create a key yet.';
      return;
    }
    $('setup-kicker').textContent = initialSetup.kicker;
    $('setup-title').textContent = initialSetup.title;
    $('setup-intro').textContent = initialSetup.intro;
    $('token').disabled = false;
    $('connect').disabled = false;
  } catch (error) {
    showError(error);
    $('check-availability').hidden = false;
  } finally { $('check-availability').disabled = false; }
}
$('check-availability').addEventListener('click', checkAvailability);
void checkAvailability();
