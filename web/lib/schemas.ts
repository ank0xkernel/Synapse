import { z } from 'zod';
import { INTERVIEW_TYPE_IDS, RESPONSE_MODE_IDS } from './constants';

const uuid = z.string().uuid();

export const jdBody = z.object({
  company: z.string().trim().max(120).default(''),
  role: z.string().trim().max(120).default(''),
  text: z.string().trim().min(20, 'paste at least a few lines').max(40_000),
  resumeId: uuid.nullable().default(null),
  responseMode: z.enum(RESPONSE_MODE_IDS).default('professional')
});

export const sessionBody = z.object({
  title: z.string().trim().min(1, 'give the session a title').max(160),
  company: z.string().trim().max(120).default(''),
  role: z.string().trim().max(120).default(''),
  interviewType: z.enum(INTERVIEW_TYPE_IDS).default('general'),
  responseMode: z.enum(RESPONSE_MODE_IDS).default('professional'),
  notes: z.string().trim().max(8000).default(''),
  status: z.enum(['draft', 'ready', 'completed']).default('draft'),
  scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
  resumeId: uuid.nullable().default(null),
  jdId: uuid.nullable().default(null)
});
