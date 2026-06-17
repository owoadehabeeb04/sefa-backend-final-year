const { EventEmitter } = require('events');

/**
 * statementImportEvents — in-process pub/sub for live statement-import progress.
 *
 * Mirrors assistantEvents.service. The background worker runs in the same process
 * as the web server, so an EventEmitter bus is sufficient to push progress from
 * the import job to an SSE endpoint. Progress is ALSO persisted on the
 * StatementImport document, so polling clients (and late SSE subscribers) always
 * see the current state even if they miss a live event.
 */

const statementImportEventBus = new EventEmitter();
statementImportEventBus.setMaxListeners(200);

const IMPORT_EVENT = 'statement.import';

const publishStatementImportEvent = (importId, event) => {
  if (!importId || !event) return;
  statementImportEventBus.emit(`${IMPORT_EVENT}:${String(importId)}`, {
    ...event,
    importId: String(importId),
    emittedAt: new Date().toISOString(),
  });
};

const subscribeToStatementImportEvents = (importId, listener) => {
  const eventKey = `${IMPORT_EVENT}:${String(importId)}`;
  statementImportEventBus.on(eventKey, listener);

  return () => {
    statementImportEventBus.off(eventKey, listener);
  };
};

module.exports = {
  publishStatementImportEvent,
  subscribeToStatementImportEvents,
};
