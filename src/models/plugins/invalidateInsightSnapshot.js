/**
 * Mongoose plugin: invalidate cached insight snapshots when underlying financial
 * data changes (expense / income / budget / category).
 *
 * It marks the affected user's MonthlyInsightSnapshot documents stale so the next
 * dashboard read recalculates fresh numbers. This single integration point covers
 * every write path — individual controllers, bulk operations, statement import
 * confirmation, and bank sync — without modifying any of them.
 *
 * Notes:
 *  - The snapshot service is required lazily to avoid a circular dependency at
 *    model-load time.
 *  - Invalidation never throws: a failure here must never break the originating
 *    write.
 */

const extractUserId = (value) => {
  if (!value) return null;
  if (value.userId) return value.userId;
  return null;
};

async function invalidate(userId) {
  if (!userId) return;
  try {
    // Lazy require — avoids circular import (service -> model -> plugin -> service).
    const insightSnapshotService = require('../../services/insights/insightSnapshot.service');
    // A transaction can move between months on edit, so invalidate all periods.
    await insightSnapshotService.invalidateUser(userId);
  } catch (_error) {
    // Swallow — invalidation is best-effort and must not affect the write.
  }
}

module.exports = function invalidateInsightSnapshotPlugin(schema) {
  // Document saves (create + .save() updates).
  schema.post('save', function postSave(doc) {
    invalidate(extractUserId(doc));
  });

  // Document removals via doc.deleteOne()/doc.remove().
  schema.post(['deleteOne', 'remove'], { document: true, query: false }, function postDocDelete(doc) {
    invalidate(extractUserId(doc));
  });

  // findOneAndUpdate / findOneAndDelete — userId comes from the affected doc.
  schema.post(['findOneAndUpdate', 'findOneAndDelete', 'findOneAndRemove'], function postFindOne(doc) {
    invalidate(extractUserId(doc));
  });

  // Bulk query updates/deletes — derive userId from the filter when present.
  schema.post(['updateOne', 'updateMany', 'deleteOne', 'deleteMany'], { query: true, document: false }, function postQuery() {
    const filter = this.getFilter ? this.getFilter() : {};
    invalidate(filter?.userId);
  });

  // insertMany (bulk creates).
  schema.post('insertMany', function postInsertMany(docs) {
    const userIds = new Set();
    (Array.isArray(docs) ? docs : []).forEach((doc) => {
      const id = extractUserId(doc);
      if (id) userIds.add(String(id));
    });
    userIds.forEach((id) => invalidate(id));
  });
};
