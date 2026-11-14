window.DENARII_CONFIG = window.DENARII_CONFIG || {};

// Local: no AI server proxy; AI uses only the user's own key.
window.DENARII_CONFIG.AI_DEFAULT_PROXY = false;

// Dev-only AI test page (#ai-test). Off: the route goes to the Dashboard
// and the test query does not run.
window.DENARII_CONFIG.ENABLE_AI_TEST_PAGE = false;

// Supabase — left empty in Denarii Local; cloud code stays dormant.
window.DENARII_CONFIG.SUPABASE_URL = '';
window.DENARII_CONFIG.SUPABASE_ANON_KEY = '';
