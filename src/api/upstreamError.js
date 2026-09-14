export function getUpstreamStatus(error) {
  return error?.response?.status || error?.status || error?.statusCode || 500;
}

async function readReadableStreamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

export async function readUpstreamErrorBody(error) {
  if (!error) return '';

  const data = error?.response?.data;

  // axios stream response
  if (data?.readable) {
    try {
      return await readReadableStreamToString(data);
    } catch {
      // fall through
    }
  }

  if (typeof data === 'object' && data !== null) {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  if (data !== undefined && data !== null) return String(data);
  if (error.message) return String(error.message);
  return String(error);
}

export function isCallerDoesNotHavePermission(errorBody) {
  try {
    return JSON.stringify(errorBody).includes('The caller does not');
  } catch {
    return String(errorBody).includes('The caller does not');
  }
}

export function getValidationRequiredDetails(errorBody) {
  let parsed = errorBody;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return null;
  const validationError = details.find(detail =>
    detail?.reason === 'VALIDATION_REQUIRED'
    && typeof detail?.metadata?.validation_url === 'string'
  );
  return validationError ? {
    reason: 'VALIDATION_REQUIRED',
    validationUrl: validationError.metadata.validation_url
  } : null;
}
