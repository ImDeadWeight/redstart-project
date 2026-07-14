'use strict'

// Built-in tools and groups that ship with Redstart Nest.
// These are hardcoded — users add their own via the UI on top of these.

export const BUILTIN_TOOLS = [
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    baseUrl: 'https://en.wikipedia.org',
    description: 'Free encyclopedia — broad general knowledge',
  },
  {
    id: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    description: 'Code repositories and README documentation',
  },
  {
    id: 'ap_news',
    name: 'AP News',
    baseUrl: 'https://apnews.com',
    description: 'Associated Press newswire — factual breaking news',
  },
  {
    id: 'bbc',
    name: 'BBC News',
    baseUrl: 'https://www.bbc.com',
    description: 'BBC international news and reporting',
  },
  {
    id: 'reuters',
    name: 'Reuters',
    baseUrl: 'https://www.reuters.com',
    description: 'Reuters international newswire',
  },
  {
    id: 'mdn',
    name: 'MDN Web Docs',
    baseUrl: 'https://developer.mozilla.org',
    description: 'Mozilla web technology reference (HTML, CSS, JS, APIs)',
  },
  {
    id: 'stackoverflow',
    name: 'Stack Overflow',
    baseUrl: 'https://stackoverflow.com',
    description: 'Programming Q&A — code solutions and explanations',
  },
  {
    id: 'cornell_law',
    name: 'Cornell LII',
    baseUrl: 'https://www.law.cornell.edu',
    description: 'Cornell Legal Information Institute — US federal law',
  },
  {
    id: 'congress',
    name: 'Congress.gov',
    baseUrl: 'https://www.congress.gov',
    description: 'US legislation, bill text, and congressional records',
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    baseUrl: 'https://arxiv.org',
    description: 'Scientific preprints — physics, CS, math, biology',
  },
  {
    id: 'pubmed',
    name: 'PubMed',
    baseUrl: 'https://pubmed.ncbi.nlm.nih.gov',
    description: 'Biomedical and life science literature',
  },
]

// Built-in capability providers — unlike BUILTIN_TOOLS these have no baseUrl
// (they aren't web whitelist entries); each needs one-time global setup
// (connection string / output folder) in the Tools window before a profile
// can activate it. See tools-storage.mjs getCapabilities/setCapabilityConfig.
export const BUILTIN_CAPABILITIES = [
  {
    id: 'postgres',
    name: 'Postgres',
    kind: 'capability',
    description: 'Read-only SQL access to a configured Postgres database — query, list tables, describe columns',
  },
  {
    id: 'documents',
    name: 'Documents',
    kind: 'capability',
    description: 'Create docx/pdf/markdown documents in a configured local output folder',
  },
]

export const BUILTIN_GROUPS = [
  {
    id: 'general',
    name: 'General Knowledge',
    description: 'Wikipedia and AP News — good all-purpose default',
    toolIds: ['wikipedia', 'ap_news'],
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'GitHub repos, MDN Web Docs, and Stack Overflow',
    toolIds: ['github', 'mdn', 'stackoverflow'],
  },
  {
    id: 'news',
    name: 'News',
    description: 'AP News, BBC, and Reuters',
    toolIds: ['ap_news', 'bbc', 'reuters'],
  },
  {
    id: 'legal_us',
    name: 'Legal (US)',
    description: 'Cornell LII, Congress.gov, and Wikipedia',
    toolIds: ['cornell_law', 'congress', 'wikipedia'],
  },
  {
    id: 'research',
    name: 'Research',
    description: 'arXiv preprints, PubMed, and Wikipedia',
    toolIds: ['arxiv', 'pubmed', 'wikipedia'],
  },
]
