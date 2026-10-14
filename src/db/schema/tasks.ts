import { pgTable, uuid, text, timestamp, date, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './core.js';

export const taskPriority = pgEnum('task_priority', ['low', 'medium', 'high']);
export const taskStatus = pgEnum('task_status', ['pending', 'in_progress', 'done', 'cancelled', 'postponed']);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  description: text('description'),
  priority: taskPriority('priority').notNull().default('medium'),
  status: taskStatus('status').notNull().default('pending'),
  dueDate: date('due_date'),
  dueTime: text('due_time'),
  project: text('project'),
  recurrence: text('recurrence'),
  parentTaskId: uuid('parent_task_id'),
  notes: text('notes'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // lembrete no WhatsApp na hora marcada; reminded_at evita mandar duas vezes
  remindAt: timestamp('remind_at', { withTimezone: true }),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
