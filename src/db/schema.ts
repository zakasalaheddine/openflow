import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

const now = () => new Date().toISOString()

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  brandProfile: text('brand_profile'),
  brandProfileVersion: integer('brand_profile_version').notNull().default(1),
  settings: text('settings', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export const anchors = sqliteTable('anchors', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  refImages: text('ref_images', { mode: 'json' }).notNull(),
  notes: text('notes'),
  // In the input hash. Bumping this is what greys out every downstream node.
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export const flows = sqliteTable('flows', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // The canvas is a view of this column, never a second source of truth.
  graphJson: text('graph_json', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(now),
})

export const nodeRuns = sqliteTable(
  'node_runs',
  {
    id: text('id').primaryKey(),
    flowId: text('flow_id').notNull(),
    nodeId: text('node_id').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').notNull(),
    modelId: text('model_id').notNull(),
    // Persisted the instant fal accepts, so a crash cannot orphan a paid run.
    falRequestId: text('fal_request_id'),
    costCents: integer('cost_cents').notNull().default(0),
    outputRefs: text('output_refs', { mode: 'json' }),
    error: text('error'),
    attempt: integer('attempt').notNull().default(0),
    claimedAt: text('claimed_at'),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (table) => [
    index('node_runs_input_hash_idx').on(table.inputHash),
    index('node_runs_status_idx').on(table.status),
    index('node_runs_flow_node_idx').on(table.flowId, table.nodeId),
  ],
)

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  // Cost one migration now; saves probing every file on disk when v2
  // sequencing arrives and needs durations it never recorded.
  durationMs: integer('duration_ms'),
  fps: integer('fps'),
  codec: text('codec'),
  sourceRunId: text('source_run_id'),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export const exports = sqliteTable('exports', {
  id: text('id').primaryKey(),
  flowId: text('flow_id').notNull(),
  format: text('format').notNull(),
  assetId: text('asset_id').references(() => assets.id),
  specCheck: text('spec_check', { mode: 'json' }),
  path: text('path').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export type NodeRun = typeof nodeRuns.$inferSelect
export type Asset = typeof assets.$inferSelect
