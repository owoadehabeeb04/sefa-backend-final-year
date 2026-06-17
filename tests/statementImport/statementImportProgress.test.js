const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

const StatementImport = require('../../src/models/StatementImport');
const {
  emitProgress,
  PROGRESS_STEPS,
  summarizeRowsConfidence,
} = require('../../src/services/statementImport.service');
const {
  publishStatementImportEvent,
  subscribeToStatementImportEvents,
} = require('../../src/services/statementImportEvents.service');

jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    const header = req.headers['x-user-id'];
    if (!header) {
      return res.status(401).json({ success: false, error: { message: 'Authentication required' } });
    }
    req.user = { userId: header, id: header, _id: header };
    req.authUser = { isVerified: true, onboardingCompleted: true };
    return next();
  },
  requireVerifiedEmail: (_req, _res, next) => next(),
  requireOnboardingComplete: (_req, _res, next) => next(),
}));

jest.mock('../../src/config/queue', () => ({
  addStatementImportJob: jest.fn().mockResolvedValue({ id: 'job-1' }),
  addNotificationJob: jest.fn().mockResolvedValue({}),
}));

const statementImportRoutes = require('../../src/routes/statementImportRoutes');

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/statement-imports', statementImportRoutes);
  return app;
};

const createImport = (userId) =>
  StatementImport.create({
    userId,
    fileName: 'statement.pdf',
    fileType: 'application/pdf',
    fileSize: 1000,
    status: 'extracting',
  });

describe('statement import progress', () => {
  it('uses the documented progress taxonomy (14 steps)', () => {
    const keys = Object.keys(PROGRESS_STEPS);
    [
      'import.created', 'upload.received', 'file.validating', 'pdf.converting',
      'page.image.created', 'ai.reading.started', 'ai.reading.page', 'ai.extraction.completed',
      'rows.normalizing', 'rows.validating', 'categories.suggesting', 'duplicates.checking',
      'review.preparing', 'import.ready', 'import.failed',
    ].forEach((step) => expect(keys).toContain(step));
  });

  it('emitProgress persists the step on the import and appends to the timeline', async () => {
    const userId = new mongoose.Types.ObjectId();
    const statementImport = await createImport(userId);

    await emitProgress(statementImport, 'pdf.converting');
    await emitProgress(statementImport, 'ai.reading.page', { pageNumber: 2 });

    const reloaded = await StatementImport.findById(statementImport._id);
    expect(reloaded.progressStep).toBe('ai.reading.page');
    expect(reloaded.progress).toHaveLength(2);
    expect(reloaded.progress[0].step).toBe('pdf.converting');
    expect(reloaded.progress[1].label).toBe('Reading page 2'); // friendly per-page label
    expect(reloaded.progressPercent).toBeGreaterThan(0);
  });

  it('emitProgress also publishes a live event to subscribers', async () => {
    const userId = new mongoose.Types.ObjectId();
    const statementImport = await createImport(userId);

    const received = [];
    const unsubscribe = subscribeToStatementImportEvents(statementImport._id, (event) => received.push(event));

    await emitProgress(statementImport, 'review.preparing');
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('review.preparing');
    expect(received[0].importId).toBe(String(statementImport._id));
  });

  it('publish/subscribe is scoped per import id', () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const aEvents = [];
    const unsub = subscribeToStatementImportEvents(a, (e) => aEvents.push(e));
    publishStatementImportEvent(b, { type: 'import.ready' }); // different import
    publishStatementImportEvent(a, { type: 'import.ready' });
    unsub();
    expect(aEvents).toHaveLength(1);
  });

  it('summarizeRowsConfidence buckets rows by confidence', () => {
    const summary = summarizeRowsConfidence([
      { confidence: 0.9 },
      { confidence: 0.6 },
      { confidence: 0.2 },
    ]);
    expect(summary.highConfidenceCount).toBe(1);
    expect(summary.mediumConfidenceCount).toBe(1);
    expect(summary.lowConfidenceCount).toBe(1);
    expect(summary.averageConfidence).toBeCloseTo(0.57, 1);
  });

  it('exposes progress fields over the polling endpoint', async () => {
    const userId = new mongoose.Types.ObjectId();
    const statementImport = await createImport(userId);
    await emitProgress(statementImport, 'ai.reading.started');

    const response = await request(createApp())
      .get(`/api/v1/statement-imports/${statementImport._id}`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data.statementImport.progressStep).toBe('ai.reading.started');
    expect(Array.isArray(response.body.data.statementImport.progress)).toBe(true);
    expect(response.body.data.statementImport.progressPercent).toBeGreaterThan(0);
  });

  it('blocks access to another user\'s import event stream', async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    const statementImport = await createImport(owner);

    const response = await request(createApp())
      .get(`/api/v1/statement-imports/${statementImport._id}/events`)
      .set('x-user-id', String(stranger));

    expect(response.status).toBe(404);
  });
});
