const DEFAULT_FOLDER_NAME = '';

const normalizePath = (value?: string) => {
  if (!value) return '';
  return value
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('/');
};

const normalizeFolderPath = (value?: string) => normalizePath(value);

export { DEFAULT_FOLDER_NAME, normalizePath, normalizeFolderPath };
