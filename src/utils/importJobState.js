const normalizeImportStatus = (status) => {
  if (!status) return 'queued';
  if (status === 'pending') return 'queued';
  return status;
};

const STAGE_MAP = {
  pending: 'queued',
  queued: 'queued',
  download: 'download',
  parse: 'parse',
  parsing: 'parse',
  ocr: 'ocr',
  needs_bank_selection: 'needs_bank_selection',
  needs_review: 'needs_review',
  importing: 'importing',
  normalize: 'normalize',
  normalizing: 'normalize',
  deduplicate: 'deduplicate',
  deduplicating: 'deduplicate',
  deduplicate_internal: 'deduplicate',
  deduplicate_database: 'deduplicate',
  categorize: 'categorize',
  categorizing: 'categorize',
  save: 'save',
  saving: 'save',
  persisting: 'save',
  completed: 'completed',
  failed: 'failed',
};

const normalizeImportStage = (stage, status) => {
  if (!stage) {
    const normalizedStatus = normalizeImportStatus(status);
    if (normalizedStatus === 'failed') return 'failed';
    if (normalizedStatus === 'completed' || normalizedStatus === 'undone') return 'completed';
    if (normalizedStatus === 'needs_bank_selection') return 'needs_bank_selection';
    if (normalizedStatus === 'needs_review') return 'needs_review';
    if (normalizedStatus === 'importing') return 'importing';
    return normalizedStatus === 'queued' ? 'queued' : 'parse';
  }

  return STAGE_MAP[stage] || stage;
};

const isImportJobActive = (status) => {
  const normalizedStatus = normalizeImportStatus(status);
  return ['queued', 'processing', 'importing'].includes(normalizedStatus);
};

module.exports = {
  normalizeImportStatus,
  normalizeImportStage,
  isImportJobActive,
};
