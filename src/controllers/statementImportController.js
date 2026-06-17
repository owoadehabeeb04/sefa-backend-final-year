const { successResponse, errorResponse } = require('../utils/response');
const { addStatementImportJob } = require('../config/queue');
const { createStatementImportSession, formatImportForResponse, getStatementImportById, getStatementImportRows, listStatementImports, updateStatementImportRow, confirmStatementImport, cancelStatementImport } = require('../services/statementImport.service');
const { subscribeToStatementImportEvents } = require('../services/statementImportEvents.service');

const resolveDeleteImportStatusCode = (message = '') => {
  if (/not found/i.test(message)) {
    return 404;
  }

  if (/cannot be deleted/i.test(message)) {
    return 400;
  }

  return 500;
};

exports.uploadStatement = async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'Please upload a PDF bank statement.', 400);
    }

    const userId = req.user.userId;
    const statementImport = await createStatementImportSession({ userId, file: req.file });

    await addStatementImportJob({
      statementImportId: statementImport._id,
      filePath: req.file.path,
    });

    return successResponse(
      res,
      { statementImport: formatImportForResponse(statementImport) },
      'Statement uploaded. We are preparing your preview.',
      202,
    );
  } catch (error) {
    console.error('Upload statement import error:', error);
    return errorResponse(res, 'We could not upload this statement. Please try again.', 500, error.message);
  }
};

exports.listImports = async (req, res) => {
  try {
    const result = await listStatementImports(req.user.userId, req.query);
    return successResponse(res, result, 'Statement imports retrieved successfully');
  } catch (error) {
    console.error('List statement imports error:', error);
    return errorResponse(res, 'Failed to retrieve statement imports', 500, error.message);
  }
};

exports.getImport = async (req, res) => {
  try {
    const statementImport = await getStatementImportById(req.user.userId, req.params.id);
    if (!statementImport) {
      return errorResponse(res, 'Statement import not found', 404);
    }

    return successResponse(
      res,
      { statementImport: formatImportForResponse(statementImport) },
      'Statement import retrieved successfully',
    );
  } catch (error) {
    console.error('Get statement import error:', error);
    return errorResponse(res, 'Failed to retrieve statement import', 500, error.message);
  }
};

/**
 * Live import progress via SSE. Mirrors the assistant chat stream: verify
 * ownership, send a snapshot from persisted progress, then push live events.
 * @route GET /api/v1/statement-imports/:id/events
 */
exports.streamImportEvents = async (req, res) => {
  const sendEvent = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const statementImport = await getStatementImportById(req.user.userId, req.params.id);
    if (!statementImport) {
      return errorResponse(res, 'Statement import not found', 404);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Snapshot so late subscribers immediately catch up to the current state.
    sendEvent('ready', {
      importId: String(statementImport._id),
      status: statementImport.status,
      progressStep: statementImport.progressStep || null,
      progressPercent: statementImport.progressPercent || 0,
      progress: statementImport.progress || [],
    });

    // If the import already finished before the client subscribed, end promptly.
    if (['reviewing', 'imported', 'failed', 'cancelled'].includes(statementImport.status)) {
      sendEvent('import.settled', { status: statementImport.status });
    }

    const unsubscribe = subscribeToStatementImportEvents(statementImport._id, (event) => {
      sendEvent(event.type || 'progress', event);
    });

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  } catch (error) {
    console.error('Stream statement import events error:', error);
    if (!res.headersSent) {
      return errorResponse(res, 'Failed to open statement import stream', 500);
    }
    res.end();
  }
};

exports.getImportRows = async (req, res) => {
  try {
    const statementImport = await getStatementImportById(req.user.userId, req.params.id);
    if (!statementImport) {
      return errorResponse(res, 'Statement import not found', 404);
    }

    const rows = await getStatementImportRows(req.user.userId, req.params.id, req.query);
    return successResponse(res, rows, 'Statement import rows retrieved successfully');
  } catch (error) {
    console.error('Get statement import rows error:', error);
    return errorResponse(res, 'Failed to retrieve statement import rows', 500, error.message);
  }
};

exports.updateImportRow = async (req, res) => {
  try {
    const row = await updateStatementImportRow(
      req.user.userId,
      req.params.id,
      req.params.rowId,
      req.body,
    );

    return successResponse(res, { row }, 'Statement import row updated successfully');
  } catch (error) {
    console.error('Update statement import row error:', error);
    const statusCode = /not found/i.test(error.message) ? 404 : 400;
    return errorResponse(res, error.message || 'Failed to update statement import row', statusCode);
  }
};

exports.confirmImport = async (req, res) => {
  try {
    const summary = await confirmStatementImport(req.user.userId, req.params.id);
    return successResponse(res, { summary }, 'Statement import completed successfully');
  } catch (error) {
    console.error('Confirm statement import error:', error);
    const statusCode = /not found/i.test(error.message) ? 404 : 400;
    return errorResponse(res, error.message || 'Failed to confirm statement import', statusCode);
  }
};

exports.deleteImport = async (req, res) => {
  try {
    await cancelStatementImport(req.user.userId, req.params.id);
    return successResponse(res, {}, 'Statement import cancelled successfully');
  } catch (error) {
    const statusCode = resolveDeleteImportStatusCode(error?.message);

    if (statusCode >= 500) {
      console.error('Delete statement import error:', error);
    }

    return errorResponse(res, error.message || 'Failed to delete statement import', statusCode);
  }
};
