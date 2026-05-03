export type ErrorWithCode = Error & { code?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getErrorMessage = (error: unknown, fallback = 'Error desconocido'): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }

  return fallback;
};

export const getErrorCode = (error: unknown): string | undefined => {
  if (error instanceof Error && typeof (error as ErrorWithCode).code === 'string') {
    return (error as ErrorWithCode).code;
  }

  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }

  return undefined;
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export const withErrorCode = <T extends Error>(error: T, code: string): T & { code: string } => {
  const codedError = error as T & { code: string };
  codedError.code = code;
  return codedError;
};
