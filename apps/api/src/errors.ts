import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Check the supplied fields',
      result.error.flatten().fieldErrors as Record<string, string[]>,
    );
  return result.data;
}
