import { z } from 'zod';
import { ARTICLE_CHANNELS, SIGN_IN_MODES } from '../../core/src/types.ts';

/** Request schemas. Validation errors become Director's VALIDATION_ERROR. */

const optionsSchema = z
  .object({
    language: z.string().min(1).max(20).optional(),
    fps: z.number().int().min(1).max(60).optional(),
    scaleHeight: z.number().int().min(120).max(2160).optional(),
    maxSteps: z.number().int().min(1).max(60).optional(),
    watermark: z.boolean().optional(),
    presetId: z.string().min(1).optional(),
    voice: z.string().min(1).optional(),
    headless: z.boolean().optional(),
    /** Documented in ARCHITECTURE §5.2; not part of core DemoOptions but honoured. */
    zoom: z.number().min(1).max(2.5).optional()
  })
  .passthrough();

export const demoCreateSchema = z
  .object({
    instruction: z.string().trim().min(3).max(2000),
    target: z
      .object({
        type: z.enum(['url', 'tunnel']).default('url'),
        url: z.string().trim().min(1)
      })
      .optional(),
    environmentId: z.string().trim().min(1).optional(),
    path: z.string().trim().max(500).optional(),
    credentials: z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .optional(),
    authorized: z.boolean().optional(),
    confirmDestructive: z.boolean().optional(),
    options: optionsSchema.optional()
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (!value.environmentId && !value.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: 'either `environmentId` or `target` is required'
      });
    }
  });

export type DemoCreateBody = z.infer<typeof demoCreateSchema>;

export const demoAnswerSchema = z.object({
  optionId: z.string().trim().min(1)
});

export const environmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().min(1),
  signInMode: z.enum(SIGN_IN_MODES).optional(),
  credentials: z
    .object({ username: z.string().min(1), password: z.string().min(1) })
    .optional(),
  storageState: z.unknown().optional()
});

export const environmentPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    signInMode: z.enum(SIGN_IN_MODES).optional()
  })
  .strict();

export const sessionSchema = z.object({
  storageState: z.unknown(),
  /** Playwright storageState with IndexedDB replay (CLI behaviour). */
  indexedDB: z.boolean().optional()
});

export const domainAttestSchema = z
  .object({
    host: z.string().trim().min(1).optional(),
    domain: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    authorized: z.boolean().optional()
  })
  .passthrough();

export const domainVerificationSchema = z.object({
  host: z.string().trim().min(1)
});

export const domainCheckSchema = z.object({
  host: z.string().trim().min(1),
  token: z.string().trim().min(1).optional()
});

export const articleFromFlowSchema = z.object({
  flowId: z.string().trim().min(1),
  channel: z.enum(ARTICLE_CHANNELS),
  environmentId: z.string().trim().min(1).optional()
});

export const articlePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    excerpt: z.string().max(2000).optional(),
    body_md: z.string().optional(),
    channel: z.enum(ARTICLE_CHANNELS).optional(),
    status: z.enum(['draft', 'published']).optional(),
    published_url: z.string().nullable().optional()
  })
  .strict();

export const guidePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    steps_json: z.unknown().optional(),
    status: z.enum(['draft', 'live']).optional()
  })
  .strict();

export const guideReportSchema = z
  .object({
    skippedStepCount: z.number().int().min(0).max(1000).optional(),
    skipped_steps: z.number().int().min(0).max(1000).optional(),
    stepIndex: z.number().int().min(0).optional(),
    step_index: z.number().int().min(0).optional(),
    reason: z.string().max(500).optional()
  })
  .passthrough();

export const presetCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: z.record(z.unknown()).optional(),
  isDefault: z.boolean().optional()
});

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120).default('default')
});

export type SessionBody = z.infer<typeof sessionSchema>;
export type GuideReportBody = z.infer<typeof guideReportSchema>;