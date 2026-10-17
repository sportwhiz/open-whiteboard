export const steps = [
  ['release', 'Verify the Open Whiteboard release'],
  ['create', 'Create your Node.js app'],
  ['attach', 'Connect your hosting plan'],
  ['addresses', 'Get your app addresses'],
  ['preview', 'Prepare a separate preview'],
  ['live', 'Configure your live whiteboard'],
  ['upload', 'Upload Open Whiteboard'],
  ['publish', 'Build and publish'],
  ['status', 'Check hosting status'],
  ['health', 'Check whiteboard readiness'],
];
export function createDeployment({ call, details, onStep = () => {}, onApp = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 60 }) {
  const state = { keys: {}, done: new Set(), appId: undefined };
  const startedAt = Date.now();
  let running = false;
  const key = stage => state.keys[stage] ||= crypto.randomUUID();
  const request = (action, values = {}) => call(action, { appId: state.appId, ...values });
  async function poll(action, record, field, refresh = false, stage) {
    state.retryStage = undefined;
    // Continue rechecks the saved operation, including a cached terminal result.
    // Keep its ID and idempotency key; never silently create a replacement.
    if (refresh) record = await request(action, { [field]: record[field] });
    for (let i = 0; i < attempts; i++) {
      if (record.status === 'COMPLETED') return record;
      if (['FAILED', 'CANCELLED'].includes(record.status)) {
        state.retryStage = stage;
        throw Object.assign(new Error('GoDaddy stopped this operation. Check the app in your GoDaddy dashboard. Continue checks the same operation.' + (stage ? ' After fixing the cause, you can retry this step on the same app.' : ' Keep this page open to preserve your progress.')), { supportReference: record.supportReference });
      }
      await sleep(5000);
      record = await request(action, { [field]: record[field] });
    }
    throw Object.assign(new Error('GoDaddy is taking longer than usual. Continue to check the same operation. Your progress is kept while this page stays open.'), { browserTimeout: true });
  }
  const actions = {
    release: () => request('verify-release'),
    create: async () => {
      const resume = Boolean(state.creation);
      state.creation ||= await request('create', { name: details.name, key: key('create') });
      state.creation = await poll('app-operation', state.creation, 'operationId', resume);
      if (!state.creation.appId) throw new Error('GoDaddy finished provisioning without returning an app identifier. Check your dashboard before retrying.');
      state.appId = state.creation.appId; onApp(state.appId);
    },
    attach: () => request('attach', { planId: details.planId }),
    addresses: async () => { state.addresses = await request('addresses'); },
    preview: () => request('configure', { variant: 'PREVIEW', passphrase: details.passphrase, key: key('preview') }),
    live: () => request('configure', { variant: 'PUBLISH', passphrase: details.passphrase, key: key('live') }),
    upload: async () => {
      const resume = Boolean(state.import);
      state.import ||= await request('upload', { key: key('upload') });
      state.import = await poll('import', state.import, 'importId', resume, 'upload');
    },
    publish: async () => {
      const resume = Boolean(state.deployment);
      state.deployment ||= await request('publish', { key: key('publish') });
      state.deployment = await poll('deployment', state.deployment, 'deploymentId', resume, 'publish');
    },
    health: async () => {
      for (let i = 0; i < attempts; i++) {
        if ((await request('health')).ready) return;
        await sleep(5000);
      }
      throw Object.assign(new Error('GoDaddy is running the server, but Open Whiteboard is not ready yet. Check the runtime logs and continue to check again.'), { browserTimeout: true });
    },
    status: async () => {
      for (let i = 0; i < attempts; i++) {
        const status = await request('status');
        if (status.running || status.known === false) return;
        await sleep(5000);
      }
      throw Object.assign(new Error('GoDaddy has not confirmed that your published app is running yet. Continue to check the same app, or open it in your GoDaddy dashboard.'), { browserTimeout: true });
    },
  };
  return {
    state,
    async run({ retryFailed = false } = {}) {
      if (running) throw new Error('A deployment check is already running.');
      if (Date.now() - startedAt >= 23 * 60 * 60 * 1000) throw new Error('This deployment session has expired. Find the app in your GoDaddy dashboard before starting another installation.');
      running = true;
      try {
        if (retryFailed) {
          const stage = state.retryStage;
          if (!state.appId || !['upload', 'publish'].includes(stage)) throw new Error('Check the current operation before retrying this step.');
          const [action, slot, field] = stage === 'upload' ? ['import', 'import', 'importId'] : ['deployment', 'deployment', 'deploymentId'];
          // Confirm the saved job is still terminal before issuing another write.
          // A lost retry response will reuse the new key through normal Continue.
          state.retryStage = undefined;
          try {
            const record = await request(action, { [field]: state[slot][field] });
            state[slot] = record;
            if (['FAILED', 'CANCELLED'].includes(record.status)) {
              delete state[slot];
              delete state.keys[stage];
            }
          } catch (error) { error.stage = stage; throw error; }
        }
        for (const [stage] of steps) {
          if (state.done.has(stage)) continue;
          onStep(stage, 'active');
          try { await actions[stage](); state.done.add(stage); onStep(stage, 'done'); }
          catch (error) { error.stage = stage; onStep(stage, 'failed'); throw error; }
        }
        details.passphrase = ''; // Release the reference after both variants are provisioned.
        return state.addresses;
      } finally { running = false; }
    },
  };
}
