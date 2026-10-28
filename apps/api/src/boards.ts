import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  boardDocumentSchema,
  boardImportSchema,
  emptyBoardDocument,
  remapBoardDocument,
  type BoardDocument,
  type BoardGroup,
  type BoardRecord,
  type BoardSummary,
} from '../../../packages/shared/src/board.js';
import { ApiError, validate } from './errors.js';
import {
  mutation,
  readSnapshot,
  staleVersion,
  transaction,
} from './resources.js';

const name = z.string().trim().min(1).max(240);
const id = z.string().min(1).max(100);
const order = z.number().int().min(0).max(1000000000);
const rowVersion = z.number().int().min(1);
const createSchema = z
  .object({
    name,
    groupId: id.nullable().optional(),
    document: boardDocumentSchema.optional(),
  })
  .strict();
const updateSchema = z
  .object({
    name: name.optional(),
    groupId: id.nullable().optional(),
    order: order.optional(),
    document: boardDocumentSchema.optional(),
    rowVersion,
  })
  .strict();
const groupCreate = z.object({ name, order: order.optional() }).strict();
const groupUpdate = z
  .object({ name: name.optional(), order: order.optional(), rowVersion })
  .strict();
const versionSchema = z.object({ rowVersion }).strict();
const reorderSchema = z
  .object({
    boards: z.array(z.object({ id, rowVersion }).strict()).max(100000),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.boards.map((board) => board.id)).size ===
      input.boards.length,
    'Each board must appear exactly once',
  );
const boardColumns =
  'id,name,group_id AS groupId,order_index AS "order",row_version AS rowVersion';
const groupColumns = 'id,name,order_index AS "order",row_version AS rowVersion';

/** Bound arbitrary annotation JSON before recursive schema validation. */
function guardJson(input: unknown): void {
  const pending: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    visited += 1;
    if (depth > 32 || visited > 200000)
      throw new ApiError(
        400,
        'DOCUMENT_TOO_COMPLEX',
        'The document exceeds the supported nesting or value count',
      );
    if (value && typeof value === 'object')
      for (const child of Object.values(value))
        pending.push({ value: child, depth: depth + 1 });
  }
}

export function registerBoards(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const route = {
    preHandler: async (request: FastifyRequest) => {
      requireAuth(request);
    },
  };
  const writeRoute = { ...route, bodyLimit: 8 * 1024 * 1024 };
  const params = (request: FastifyRequest) =>
    request.params as { boardId?: string; groupId?: string };
  const group = (groupId: string): BoardGroup => {
    const record = db
      .prepare(`SELECT ${groupColumns} FROM board_groups WHERE id=?`)
      .get(groupId) as BoardGroup | undefined;
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Group not found');
    return record;
  };
  const board = (boardId: string): BoardRecord => {
    const record = db
      .prepare(
        `SELECT ${boardColumns},document_json AS documentJson FROM boards WHERE id=?`,
      )
      .get(boardId) as (BoardSummary & { documentJson: string }) | undefined;
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Board not found');
    const { documentJson, ...summary } = record;
    return { ...summary, document: JSON.parse(documentJson) as BoardDocument };
  };
  const requireGroup = (groupId: string | null) => {
    if (groupId !== null) group(groupId);
  };
  const nextOrder = (table: 'boards' | 'board_groups') =>
    Number(
      (
        db
          .prepare(
            `SELECT coalesce(max(order_index),-1)+1 AS next FROM ${table}`,
          )
          .get() as { next: number }
      ).next,
    );
  const insert = (
    boardName: string,
    groupId: string | null,
    document: BoardDocument,
  ): BoardRecord => {
    requireGroup(groupId);
    const boardId = randomUUID();
    db.prepare(
      'INSERT INTO boards (id,name,group_id,order_index,document_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      boardId,
      boardName,
      groupId,
      nextOrder('boards'),
      JSON.stringify(document),
      Date.now(),
      Date.now(),
    );
    return board(boardId);
  };
  const listBoards = () => ({
    boards: db
      .prepare(`SELECT ${boardColumns} FROM boards ORDER BY order_index,id`)
      .all() as unknown as BoardSummary[],
    groups: db
      .prepare(
        `SELECT ${groupColumns} FROM board_groups ORDER BY order_index,id`,
      )
      .all() as unknown as BoardGroup[],
  });

  app.post('/api/v1/boards/reorder', writeRoute, async (request) => {
    const input = validate(reorderSchema, request.body);
    return mutation(() =>
      transaction(db, () => {
        const current = db
          .prepare(`SELECT ${boardColumns} FROM boards`)
          .all() as unknown as BoardSummary[];
        const byId = new Map(current.map((board) => [board.id, board]));
        if (
          current.length !== input.boards.length ||
          input.boards.some((board) => !byId.has(board.id))
        ) {
          throw new ApiError(
            409,
            'BOARD_LIST_CHANGED',
            'The board list changed. Reload before reordering',
          );
        }
        for (const board of input.boards)
          if (byId.get(board.id)!.rowVersion !== board.rowVersion)
            staleVersion();
        const update = db.prepare(
          'UPDATE boards SET order_index=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
        );
        for (const [index, board] of input.boards.entries()) {
          if (byId.get(board.id)!.order === index) continue;
          if (
            !update.run(index, Date.now(), board.id, board.rowVersion).changes
          )
            staleVersion();
        }
        return listBoards();
      }),
    );
  });

  app.get('/api/v1/boards', route, async () => readSnapshot(db, listBoards));
  app.post('/api/v1/boards', writeRoute, async (request, reply) => {
    guardJson(request.body);
    const input = validate(createSchema, request.body);
    const record = mutation(() =>
      transaction(db, () =>
        insert(
          input.name,
          input.groupId ?? null,
          input.document ?? emptyBoardDocument(),
        ),
      ),
    );
    return reply.code(201).send({ board: record });
  });
  app.get('/api/v1/boards/:boardId', route, async (request) => ({
    board: board(params(request).boardId!),
  }));
  app.patch('/api/v1/boards/:boardId', writeRoute, async (request) => {
    guardJson(request.body);
    const input = validate(updateSchema, request.body);
    return mutation(() =>
      transaction(db, () => {
        const current = board(params(request).boardId!);
        if (current.rowVersion !== input.rowVersion) staleVersion();
        const groupId =
          input.groupId === undefined ? current.groupId : input.groupId;
        requireGroup(groupId);
        db.prepare(
          'UPDATE boards SET name=?,group_id=?,order_index=?,document_json=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
        ).run(
          input.name ?? current.name,
          groupId,
          input.order ?? current.order,
          JSON.stringify(input.document ?? current.document),
          Date.now(),
          current.id,
          input.rowVersion,
        );
        return { board: board(current.id) };
      }),
    );
  });
  app.delete('/api/v1/boards/:boardId', writeRoute, async (request, reply) => {
    const input = validate(versionSchema, request.body);
    mutation(() =>
      transaction(db, () => {
        const current = board(params(request).boardId!);
        if (current.rowVersion !== input.rowVersion) staleVersion();
        db.prepare('DELETE FROM boards WHERE id=?').run(current.id);
      }),
    );
    return reply.code(204).send();
  });
  app.post(
    '/api/v1/boards/:boardId/duplicate',
    writeRoute,
    async (request, reply) => {
      if (request.body !== undefined)
        validate(z.object({}).strict(), request.body);
      const record = mutation(() =>
        transaction(db, () => {
          const source = board(params(request).boardId!);
          return insert(
            source.name.slice(0, 235) + ' copy',
            source.groupId,
            remapBoardDocument(source.document),
          );
        }),
      );
      return reply.code(201).send({ board: record });
    },
  );
  app.get('/api/v1/boards/:boardId/export', route, async (request, reply) => {
    const source = board(params(request).boardId!);
    reply
      .header(
        'Content-Disposition',
        `attachment; filename="portfolio-board-${source.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json"`,
      )
      .type('application/json');
    return {
      format: 'portfolio-board',
      schemaVersion: 1,
      name: source.name,
      document: source.document,
    };
  });
  app.post('/api/v1/boards/import', writeRoute, async (request, reply) => {
    guardJson(request.body);
    const input = validate(boardImportSchema, request.body);
    const record = mutation(() =>
      transaction(db, () =>
        insert(input.name, null, remapBoardDocument(input.document)),
      ),
    );
    return reply.code(201).send({ board: record });
  });

  app.post('/api/v1/board-groups', route, async (request, reply) => {
    const input = validate(groupCreate, request.body);
    const groupId = randomUUID();
    mutation(() =>
      transaction(db, () => {
        db.prepare(
          'INSERT INTO board_groups (id,name,order_index,created_at,updated_at) VALUES (?,?,?,?,?)',
        ).run(
          groupId,
          input.name,
          input.order ?? nextOrder('board_groups'),
          Date.now(),
          Date.now(),
        );
      }),
    );
    return reply.code(201).send({ group: group(groupId) });
  });
  app.patch('/api/v1/board-groups/:groupId', route, async (request) => {
    const input = validate(groupUpdate, request.body);
    return mutation(() =>
      transaction(db, () => {
        const current = group(params(request).groupId!);
        if (current.rowVersion !== input.rowVersion) staleVersion();
        db.prepare(
          'UPDATE board_groups SET name=?,order_index=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
        ).run(
          input.name ?? current.name,
          input.order ?? current.order,
          Date.now(),
          current.id,
          input.rowVersion,
        );
        return { group: group(current.id) };
      }),
    );
  });
  app.delete('/api/v1/board-groups/:groupId', route, async (request, reply) => {
    const input = validate(versionSchema, request.body);
    mutation(() =>
      transaction(db, () => {
        const current = group(params(request).groupId!);
        if (current.rowVersion !== input.rowVersion) staleVersion();
        db.prepare(
          'UPDATE boards SET group_id=NULL,row_version=row_version+1,updated_at=? WHERE group_id=?',
        ).run(Date.now(), current.id);
        db.prepare('DELETE FROM board_groups WHERE id=?').run(current.id);
      }),
    );
    return reply.code(204).send();
  });
}
