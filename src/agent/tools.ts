import { tool } from 'ai'
import {
  addNodeInput,
  applyTemplateInput,
  deleteNodeInput,
  listGraphInput,
  listSourcesInput,
  unwireInput,
  updateNodeInput,
  wireInput,
  type Ops,
} from './ops'

/**
 * Wrappers, and nothing else. Every description says when to reach for the
 * tool, because a description that only says what a tool does gets called less
 * than one that says when.
 *
 * There is no run tool, deliberately. See ops.ts.
 */
export const createTools = (ops: Ops) => ({
  list_graph: tool({
    description:
      'Read the current graph: every node with its settings and estimated cost, and every edge. Call this first, and again after any change you did not make yourself.',
    inputSchema: listGraphInput,
    execute: async () => ops.listGraph(),
  }),

  list_sources: tool({
    description:
      "List the project's uploaded assets. Call this before adding a source node — you need a real source id, and you cannot invent one.",
    inputSchema: listSourcesInput,
    execute: async () => ops.listSources(),
  }),

  add_node: tool({
    description:
      'Add one node and return its id. Types: source (an existing asset, needs sourceId), image (a still, needs prompt), video (a clip, needs prompt), export (the deliverable formats). Nothing renders until the person presses Run.',
    inputSchema: addNodeInput,
    execute: async (input) => ops.addNode(input),
  }),

  update_node: tool({
    description:
      'Change a node in place. Only the fields you pass change. Use this to reword a prompt or move a shot from draft to hero, rather than deleting and re-adding it.',
    inputSchema: updateNodeInput,
    execute: async (input) => ops.updateNode(input),
  }),

  delete_node: tool({
    description: 'Remove a node. Its edges go with it.',
    inputSchema: deleteNodeInput,
    execute: async (input) => ops.deleteNode(input),
  }),

  wire: tool({
    description:
      'Connect two nodes. The meaning follows from the types: an asset into a shot is a reference the model must honour, a still into a clip is that clip\'s first frame. May be refused — too many references for the chosen model, a second first frame, or a cycle. Read the refusal and adjust.',
    inputSchema: wireInput,
    execute: async (input) => ops.wire(input),
  }),

  unwire: tool({
    description: 'Remove one edge by its id, leaving both nodes in place.',
    inputSchema: unwireInput,
    execute: async (input) => ops.unwire(input),
  }),

  apply_template: tool({
    description:
      'Replace the whole graph with a ready-made shape, with its slots filled. A good opening move on an empty canvas; destructive on one with work in it, so read the graph first.',
    inputSchema: applyTemplateInput,
    execute: async (input) => ops.applyTemplate(input),
  }),
})
