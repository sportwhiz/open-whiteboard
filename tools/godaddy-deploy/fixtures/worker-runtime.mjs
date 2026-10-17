import { createApi } from '../api.mjs';

// Exercise the real Workers fetch implementation against a local HTTP fixture.
// Only the destination is substituted; request options and credentials are not.
export default {
  fetch(request, env) {
    return createApi({
      release: { version: '0.0.0', qualified: false },
      fetchImpl: (url, options) => fetch(env.FIXTURE_ORIGIN + new URL(url).pathname, options),
    })(request);
  },
};
