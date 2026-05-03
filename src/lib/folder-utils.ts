const DEFAULT_FOLDER_NAME = 'No estructurado';

const normalizePath = (value?: string) => {
  if (!value) return '';
  return value
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('/');
};

const normalizeFolderPath = (value?: string) => {
  const normalized = normalizePath(value);
  return normalized || DEFAULT_FOLDER_NAME;
};

export { DEFAULT_FOLDER_NAME, normalizePath, normalizeFolderPath };
