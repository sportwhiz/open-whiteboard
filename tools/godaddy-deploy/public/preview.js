// An explicit browser-only walkthrough. Never contacts the installer API or GoDaddy.
export function preparePreview() {
  const banner = document.createElement('aside');
  banner.className = 'preview-banner';
  banner.setAttribute('aria-label', 'Setup preview');
  banner.innerHTML = '<a href="/">← Back to the site</a><p><strong>Interactive setup preview</strong> · Example data only. No key, account, or purchase needed.</p>';
  document.body.prepend(banner);
  document.title = 'GoDaddy setup preview · Open Whiteboard';
  document.querySelector('.brand').href = '/';
  document.querySelector('.brand').removeAttribute('target');
  const token = document.getElementById('token');
  token.value = 'example-key-for-this-preview';
  token.readOnly = true;
  token.setAttribute('aria-describedby', 'preview-key-help');
  const help = document.createElement('p'); help.id = 'preview-key-help'; help.className = 'preview-hint';
  help.textContent = 'We’ve filled in an example key. In the live installer, you would create and paste your own temporary key.';
  token.after(help);
  const pass = document.getElementById('passphrase');
  pass.value = 'Example setup passphrase'; pass.readOnly = true;
  document.getElementById('generate-passphrase').hidden = true;
  document.getElementById('passphrase-help').textContent = 'This is an example. In the live flow, save your passphrase before continuing. You’ll use it to create your owner account.';
  document.getElementById('deploy').textContent = 'Preview deployment →';
  document.querySelector('#deploy-form .center').textContent = 'This walkthrough takes a few seconds. A real deployment usually takes a few minutes.';
  document.querySelectorAll('a[href="https://developer.godaddy.com/personal-access-token"]').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      document.getElementById('permissions').open = true;
      help.textContent = 'In the live flow, this opens GoDaddy’s token page. Choose Generate Token, name it Open Whiteboard setup, choose 7 days, select the permissions below, then copy the token. This preview already has an example key.';
      help.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}
export async function previewCall(action) {
  // Give each real workflow stage time to be visible without imitating real hosting latency.
  await new Promise(resolve => setTimeout(resolve, action === 'release-status' ? 0 : 450));
  switch (action) {
    case 'release-status': return { qualified: true, version: 'preview' };
    case 'connect': return { release: { version: 'preview' }, plans: [{ id: 'example-plan', name: 'My GoDaddy hosting plan (example)', available: true, slots: 3 }] };
    case 'verify-release': return { verified: true };
    case 'create': return { operationId: 'example-creation', status: 'COMPLETED', appId: 'NODEJS-example' };
    case 'app-operation': return { operationId: 'example-creation', status: 'COMPLETED', appId: 'NODEJS-example' };
    case 'addresses': return { preview: 'https://preview.example.invalid', publish: 'https://whiteboard.example.invalid' };
    case 'configure': return { configured: true };
    case 'attach': return { attached: true };
    case 'upload': return { importId: 'example-import', status: 'COMPLETED' };
    case 'import': return { importId: 'example-import', status: 'COMPLETED' };
    case 'publish': return { deploymentId: 'example-publish', status: 'COMPLETED' };
    case 'deployment': return { deploymentId: 'example-publish', status: 'COMPLETED' };
    case 'status': return { running: true };
    case 'health': return { ready: true };
    default: throw new Error('This action is not part of the setup preview.');
  }
}
export function finishPreview() {
  const success = document.getElementById('success');
  success.innerHTML = `<div class="success-mark" aria-hidden="true">✓</div>
    <p class="eyebrow">DEPLOYMENT PREVIEW COMPLETE</p><h2>Next, make it yours.</h2>
    <p>In a real deployment, your private whiteboard opens here. No app was created in this preview.</p>
    <ol class="finish-steps">
      <li><strong>Create your owner account</strong><p>Enter your saved setup passphrase, choose your sign-in details, and save your recovery code.</p></li>
      <li><strong>Secure your account</strong><p>Connect your authenticator. Then invite your team and start your first board.</p></li>
      <li><strong>Remove the temporary key</strong><p>In GoDaddy, find “Open Whiteboard setup,” open its ⋯ menu, and choose Revoke. Installation is finished.</p></li>
    </ol>
    <button id="preview-updates" type="button">See how automatic updates work →</button>
    <p class="hint">The live installer will open after a qualified release is published.</p>`;
  document.getElementById('preview-updates').addEventListener('click', () => {
    success.innerHTML = `<p class="eyebrow">AFTER INSTALLATION · ADMINISTRATION → UPDATES</p><h2>Keep your whiteboard up to date.</h2>
      <p>Connect a separate update token once. Your whiteboard keeps it encrypted and checks for releases daily.</p>
      <div class="preview-update-card"><strong>Connect GoDaddy updates</strong><p>The Updates page links to GoDaddy and shows the four permissions to select. This token can last longer than your temporary setup key.</p><button id="preview-connect-updates" class="secondary" type="button">Use an example update connection</button><p id="preview-update-status" class="hint" role="status">Example only. No credential is saved.</p></div>
      <label class="preview-check"><input id="preview-security" type="checkbox" disabled> Install compatible security patches automatically</label>
      <p class="hint">New features wait for you to choose Update now. If a token expires, reconnect from this page. Your whiteboard keeps working.</p>
      <a class="button" href="/demo/">Try the whiteboard demo →</a><a class="preview-back" href="?preview=1">Walk through setup again</a>`;
    document.getElementById('preview-connect-updates').addEventListener('click', event => {
      event.currentTarget.hidden = true;
      document.getElementById('preview-update-status').textContent = 'Example connection ready. Try the preference below.';
      document.getElementById('preview-security').disabled = false;
    });
    document.getElementById('preview-security').addEventListener('change', event => {
      document.getElementById('preview-update-status').textContent = event.currentTarget.checked ? 'Preview: compatible security patches would install automatically.' : 'Preview: you would choose when to install each release.';
    });
    success.focus();
    document.querySelector('[data-journey=account] strong').textContent = 'Account & updates';
  });
  success.focus();
}
